import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createGenter } from "../src/genter.js";
import { buildSkill, normalizeFiles, SKILL_TOOLS } from "../src/skills.js";

const SKILL = (extra = "") => `---
name: deploy-guide
description: How to deploy the service to production.
---

# Deploy guide

Overview of deploying.

## Install

Run \`scripts/install.sh\` and read [the config](config/app.json).

## Rollback

Use \`scripts/rollback.sh\` to go back. ${extra}
`;

// A host store of skills in memory: what the backend keeps in Postgres. Vectors are made by `vector` (two axes).
function host({ vector = (t) => (/deploy|install|rollback/i.test(t) ? [1, 0] : [0, 1]) } = {}) {
  const skills = new Map();
  const put = (id, list) => {
    const files = normalizeFiles(list.map(([path, text]) => ({ path, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text) })));
    const built = buildSkill(files);
    const chunks = built.chunks.map((c) => ({ ...c, embedding: vector(`${built.name} ${c.headings.join(" ")}`) }));
    skills.set(id, { id, ...built, chunks, embedding: vector(`${built.name} ${built.description}`), bytes: new Map(files.map((f) => [f.path, f.bytes])) });
    return skills.get(id);
  };
  const store = {
    list: async () => [...skills.values()],
    get: async (id) => skills.get(id) ?? null,
    text: async (id, path) => skills.get(id)?.texts.get(path) ?? null,
    file: async (id, path) => {
      const bytes = skills.get(id)?.bytes.get(path);
      if (!bytes) return null;
      return bytes.length <= 64 * 1024 && !bytes.includes(0) ? { text: bytes.toString("utf8") } : { url: `https://api.example/skills/${id}/files?path=${encodeURIComponent(path)}` };
    },
  };
  return { put, store, skills };
}

const FILES = (extra) => [
  ["SKILL.md", SKILL(extra)],
  ["scripts/install.sh", "#!/bin/sh\necho INSTALL\n"],
  ["scripts/rollback.sh", "#!/bin/sh\nexit 1\n"],
  ["config/app.json", '{"a":1}'],
  ["assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1])],
];

const memoryStore = () => {
  const rows = new Map();
  return { rows, get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), all: async () => [...rows.values()].filter((r) => r.remembered), remove: async (id) => rows.delete(id) };
};

// Anything that leaves the process is recorded: skills never touch Composio, and only embeddings reach OpenRouter.
let restore;
afterEach(() => restore?.());
function net(vector = (t) => (/deploy|install|rollback/i.test(t) ? [1, 0] : [0, 1])) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    if (String(url).includes("openrouter.ai/api/v1/embeddings")) {
      const input = [JSON.parse(init.body).input].flat();
      return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vector(t) })) }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  restore = () => (globalThis.fetch = original);
  return urls;
}

function setup(extra = {}) {
  const h = host();
  const skill = h.put("sk1", FILES());
  const store = memoryStore();
  const deferred = [];
  const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", workspaceId: "w", secret: "s", store, skills: h.store, defer: (p) => deferred.push(p), ...extra });
  return { h, skill, store, genter, flush: () => Promise.all(deferred.splice(0)) };
}
const chunkArgs = (skill, title) => ({ skill: skill.id, version: skill.version, chunk: skill.chunks.find((c) => c.title === title).id });

describe("reading a piece of a skill is one call, saved as one anchor", () => {
  it("S1 returns the piece, the files it points to, and saves a deterministic anchor with no Composio call", async () => {
    const urls = net();
    const { genter, skill, store, flush } = setup();
    const out = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Install"), task: "how do I install it" });
    assert.equal(out.result.successful, true);
    const d = out.result.data;
    assert.equal(d.section.title, "Install");
    assert.match(d.text, /Run `scripts\/install\.sh`/);
    assert.ok(!d.text.includes("Rollback")); // the piece, not the whole skill
    assert.deepEqual(d.related.map((r) => [r.path, r.kind, r.executable_code ?? false]), [["config/app.json", "artifact", false], ["scripts/install.sh", "script", true]]);
    assert.match(d.related[1].note, /does NOT run/);
    assert.deepEqual(d.related[1].get.args, { skill: "sk1", version: skill.version, path: "scripts/install.sh" });
    assert.match(d.related[1].get.id, /^rcp_[0-9a-f]{24}$/);
    assert.match(out.id, /^rcp_[0-9a-f]{24}$/);
    await flush();
    const rec = (await genter.recipes.get(out.id));
    assert.equal(rec.scope.toolkit, "skill");
    assert.equal(rec.status, "fresh");
    assert.deepEqual(rec.source.path, ["deploy-guide", "Deploy guide", "Install"]);
    assert.ok(rec.summary.includes("Install"));
    assert.equal(store.rows.size, 1);
    assert.ok(!urls.some((u) => /backend\.composio\.dev|\/tools\/|chat\/completions/.test(u)), "no Composio tool call, no chat model");
  });

  it("S1b the piece is titled and placed from its first save, before its vector is made: a list never shows it untitled", async () => {
    net();
    const { genter, skill, flush } = setup();
    const out = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Rollback") });
    const early = await genter.recipes.get(out.id); // the description step has not run yet (deferred)
    assert.equal(early.title, "deploy-guide: Rollback");
    assert.deepEqual(early.source.path, ["deploy-guide", "Deploy guide", "Rollback"]);
    assert.equal(early.scope.toolkit, "skill");
    assert.ok(early.summary.includes("rollback.sh"));
    await flush();
    const late = await genter.recipes.get(out.id);
    assert.equal(late.title, early.title);
    const file = await genter.execute({ tool: SKILL_TOOLS.file, args: { skill: skill.id, version: skill.version, path: "config/app.json" } });
    assert.equal((await genter.recipes.get(file.id)).title, "deploy-guide: config/app.json");
    await flush();
  });

  it("S2 asking for the same piece in other words is the same anchor with one more intent key", async () => {
    net();
    const { genter, skill, store, flush } = setup();
    const args = chunkArgs(skill, "Install");
    const a = await genter.execute({ tool: SKILL_TOOLS.chunk, args, task: "how do I install it" });
    await flush();
    const b = await genter.execute({ tool: SKILL_TOOLS.chunk, args, task: "setup steps for the service" });
    await flush();
    const c = await genter.execute({ tool: SKILL_TOOLS.chunk, args, task: "  How do I install it " });
    await flush();
    assert.equal(a.id, b.id);
    assert.equal(a.id, c.id);
    assert.equal(store.rows.size, 1);
    assert.equal(b.unchanged, true);
    assert.deepEqual((await genter.recipes.get(a.id)).intents, ["how do I install it", "setup steps for the service"]);
  });

  it("S3 different pieces are different anchors", async () => {
    net();
    const { genter, skill, store, flush } = setup();
    const a = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Install") });
    const b = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Rollback") });
    await flush();
    assert.notEqual(a.id, b.id);
    assert.equal(store.rows.size, 2);
  });

  it("S4 a failed read (unknown section) saves nothing", async () => {
    net();
    const { genter, skill, store } = setup();
    const out = await genter.execute({ tool: SKILL_TOOLS.chunk, args: { skill: "sk1", version: skill.version, chunk: "SKILL.md#nope" } });
    assert.equal(out.result.successful, false);
    assert.equal(out.id, undefined);
    assert.equal(store.rows.size, 0);
  });
});

describe("files and scripts", () => {
  it("S5 a script is handed over as code with the executable label and is never run", async () => {
    const urls = net();
    const { genter, skill, flush } = setup();
    const out = await genter.execute({ tool: SKILL_TOOLS.file, args: { skill: "sk1", version: skill.version, path: "scripts/rollback.sh" } });
    await flush();
    const d = out.result.data;
    assert.equal(d.kind, "script");
    assert.equal(d.executable_code, true);
    assert.match(d.note, /does NOT run/);
    assert.equal(d.text, "#!/bin/sh\nexit 1\n");
    assert.ok(!urls.some((u) => /backend\.composio\.dev|\/tools\//.test(u)));
    const rec = await genter.recipes.get(out.id);
    assert.match(rec.summary, /Executable code \(Genter does not run it\)/);
  });

  it("S5b nothing in the engine can run a script", () => {
    for (const file of ["src/skills.js", "src/genter.js"]) {
      const code = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      assert.ok(!/child_process|node:vm|\beval\(|new Function\(|worker_threads/.test(code), `${file} must not execute code`);
    }
  });

  it("S6 a binary artifact is a link to the storage, not its content", async () => {
    net();
    const { genter, skill } = setup();
    const out = await genter.execute({ tool: SKILL_TOOLS.file, args: { skill: "sk1", version: skill.version, path: "assets/logo.png" }, remember: false });
    const d = out.result.data;
    assert.equal(d.kind, "artifact");
    assert.equal(d.mime, "image/png");
    assert.equal(d.text, undefined);
    assert.match(d.url, /^https:\/\/api\.example\/skills\/sk1\/files\?path=assets%2Flogo\.png$/);
  });

  it("S6b a text artifact is returned as text", async () => {
    net();
    const { genter, skill } = setup();
    const out = await genter.execute({ tool: SKILL_TOOLS.file, args: { skill: "sk1", version: skill.version, path: "config/app.json" }, remember: false });
    assert.equal(out.result.data.text, '{"a":1}');
    assert.equal(out.result.data.executable_code, undefined);
  });
});

describe("versions", () => {
  it("S7 an update makes old anchors outdated; the ones whose piece survives are made again with their intents", async () => {
    net();
    const { genter, h, skill, flush } = setup();
    const install = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Install"), task: "install it" });
    const rollback = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Rollback"), task: "undo a deploy" });
    await flush();
    // Version 2: Rollback changes its text, a new section appears, Install is removed from the file list? (kept) -> Install stays.
    const next = h.put("sk1", FILES("Now with dry runs."));
    assert.notEqual(next.version, skill.version);
    // The old call is now outdated: "not found", and the anchor goes gone.
    const old = await genter.execute({ id: install.id });
    assert.equal(old.result.successful, false);
    assert.equal(old.recipe_status, "gone");
    const { carried, gone } = await genter.skills.update({ skill: "sk1", version: next.version });
    await flush();
    assert.equal(gone, 0);
    assert.equal(carried.length, 2);
    const made = await genter.recipes.get(carried.find((c) => c.from === install.id).to);
    assert.equal(made.args.version, next.version);
    assert.equal(made.status, "fresh");
    assert.deepEqual(made.intents, ["install it"]);
    assert.equal(await genter.recipes.get(rollback.id), null); // replaced by the one of the new version
    assert.equal((await genter.skills.recipes({ skill: "sk1" })).length, 2);
  });

  it("S8 a piece that no longer exists leaves an anchor that is gone, not deleted", async () => {
    net();
    const { genter, h, skill, flush } = setup();
    const rollback = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Rollback") });
    await flush();
    const next = h.put("sk1", [["SKILL.md", "---\nname: deploy-guide\ndescription: x\n---\n# Deploy guide\n\nOnly this now.\n"]]);
    const { carried, gone } = await genter.skills.update({ skill: "sk1", version: next.version });
    assert.deepEqual(carried, []);
    assert.equal(gone, 1);
    assert.equal((await genter.recipes.get(rollback.id)).status, "gone");
  });

  it("S9 deleting a skill deletes its anchors", async () => {
    net();
    const { genter, h, skill, flush } = setup();
    const a = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Install") });
    await flush();
    h.skills.delete("sk1");
    assert.deepEqual(await genter.skills.removed({ skill: "sk1" }), { count: 1 });
    assert.equal(await genter.recipes.get(a.id), null);
    assert.ok(!(await genter.recipes.list()).some((r) => r.id === a.id));
  });
});

describe("search", () => {
  it("S10 pieces of skills are found by meaning, with fixed args; a saved piece is offered once, as its anchor", async () => {
    net();
    const { genter, skill, flush } = setup();
    const found = await genter.search({ query: "how to deploy and roll back", limit: 10 });
    const pieces = found.filter((f) => f.kind === "skill");
    assert.ok(pieces.length >= 2);
    assert.ok(pieces.every((p) => p.tool === SKILL_TOOLS.chunk && p.id === null && p.args.skill === "sk1" && p.args.version === skill.version));
    assert.ok(pieces.some((p) => p.title === "deploy-guide › Deploy guide › Install"));
    const read = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Install"), task: "how to deploy and roll back" });
    await flush();
    const again = await genter.search({ query: "how to deploy and roll back", limit: 10 });
    assert.equal(again.filter((f) => f.id === read.id).length, 1);
    assert.ok(!again.some((f) => f.kind === "skill" && f.recipe_id === read.id));
  });

  it("S12 within (a person limited to some projects): only those anchors, a piece only as its anchor there", async () => {
    net();
    const { genter, skill, flush } = setup();
    const install = await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Install"), task: "install" });
    await genter.execute({ tool: SKILL_TOOLS.chunk, args: chunkArgs(skill, "Rollback"), task: "rollback" });
    await flush();
    const found = await genter.search({ query: "how to deploy and roll back", limit: 10, within: new Set([install.id]) });
    assert.deepEqual(
      found.map((f) => [f.id, f.kind ?? null]),
      [[install.id, null]],
    );
  });

  it("S11 an unrelated request does not find skill pieces", async () => {
    net();
    const { genter } = setup();
    const found = await genter.search({ query: "my unread email from today", limit: 5 }).catch(() => []);
    assert.ok(!found.some((f) => f.kind === "skill"));
  });
});
