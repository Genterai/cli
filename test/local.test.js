import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bm25, prepare, stem, terms } from "../src/lexical.js";
import { createLocal, FILE_READ, findText, listFolder } from "../src/local.js";
import { recipeId } from "../src/recipe.js";
import { cipher } from "../src/seal.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// A folder of files and a Genter home of its own, both in a fresh temp folder.
function sandbox(files = {}) {
  const base = mkdtempSync(join(tmpdir(), "genter-local-"));
  const dir = join(base, "project");
  const home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) put(dir, path, text);
  return { base, dir, home, done: () => rmSync(base, { recursive: true, force: true }) };
}
function put(dir, path, text) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}
const textOf = (out) => out.results.map((r) => r.text).join("\n");

const DEPLOY = "# Deploy\n\n## Staging\n\nStaging deploys every Tuesday. The pooler listens on port 6432.\n\n## Production\n\nProduction ships on Thursday after the change review.\n";
const ONCALL = "# On-call\n\nPage the on-call engineer in #beacon-oncall. Escalate to Dana after 15 minutes.\n";

describe("lexical ranking", () => {
  it("stems English and Russian words to one form", () => {
    assert.equal(stem("deployed"), stem("deploys"));
    assert.equal(stem("deploying"), "deploy");
    assert.equal(stem("releases"), stem("release"));
    assert.equal(stem("письма"), stem("письмо"));
    assert.deepEqual(terms("The pgBouncer listens on port 6432"), ["pgbouncer", "pg", "bouncer", "listen", "port", "6432"]);
  });

  it("[spec:local-search/ranking-words] counts a word in the headings more than one in the text", () => {
    const docs = [prepare({ head: "notes", body: "we talked about the pooler once" }), prepare({ head: "Database pooler", body: "settings" })];
    const [inText, inHead] = bm25("pooler", docs);
    assert.ok(inHead > inText);
    assert.equal(bm25("nothing shared", docs).every((s) => s === 0), true);
  });
});

describe("local search", () => {
  it("[spec:local-search/ac-changed-file] answers with the file as it is now and says it changed", async () => {
    const box = sandbox({ "docs/deploy.md": DEPLOY, "docs/oncall.md": ONCALL });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add("docs");
      const before = await g.find("which port does the staging pooler use?");
      assert.match(before.results[0].text, /6432/);
      assert.equal(before.results[0].place, "docs/deploy.md:3-5");
      assert.deepEqual(before.changes, []);

      put(box.dir, "docs/deploy.md", DEPLOY.replace("6432", "5433"));
      const after = await g.find("which port does the staging pooler use?");
      assert.match(after.results[0].text, /5433/);
      assert.ok(after.results[0].facts.includes("changed since the last look"));
      assert.doesNotMatch(textOf(after), /6432/);
      assert.deepEqual(after.changes, [{ place: "docs/deploy.md", event: "changed" }]);
      assert.match(findText(after), /^Since the last look: docs\/deploy\.md changed\./);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/ac-deleted-file] [spec:local-search/gone-not-answer] lists a deleted file as gone and answers nothing from it", async () => {
    const box = sandbox({ "docs/deploy.md": DEPLOY, "docs/oncall.md": ONCALL });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add("docs");
      rmSync(join(box.dir, "docs/oncall.md"));
      const out = await g.find("who do I escalate to on-call?");
      assert.deepEqual(out.changes, [{ place: "docs/oncall.md", event: "gone" }]);
      assert.equal(out.results.some((r) => r.path.endsWith("oncall.md")), false);
      assert.equal(g.sources()[0].gone, 1);

      put(box.dir, "docs/oncall.md", ONCALL);
      const back = await g.find("who do I escalate to on-call?");
      assert.ok(back.results[0].path.endsWith("oncall.md"));
      assert.equal(back.results[0].anchor.status, "fresh");
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/ac-replaced] [spec:local-search/follow-replaced] brings what replaces a deprecated file right after it", async () => {
    const box = sandbox({
      "ops/deploy.md": "> **Deprecated:** replaced by [Deploy v2](deploy-v2.md)\n\n# Deploy\n\nProduction deploys run from Jenkins on Thursday.\n",
      "ops/deploy-v2.md": "# Deploy v2\n\nProduction ships from GitHub Actions on Wednesday.\n",
      "ops/other.md": "# Other\n\nNothing about shipping here.\n",
    });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add(".");
      const out = await g.find("Jenkins production deploys", { limit: 1 });
      assert.equal(out.results[0].path, join(box.dir, "ops/deploy.md"));
      assert.equal(out.results[0].anchor.superseded.by, join(box.dir, "ops/deploy-v2.md"));
      assert.ok(out.results[0].facts.includes("marked as replaced: ops/deploy-v2.md"));
      assert.equal(out.results[1].path, join(box.dir, "ops/deploy-v2.md"));
      assert.equal(out.results[1].replaces, 1);
      assert.match(findText(out), /\[2\] ops\/deploy-v2\.md:1-3 · Deploy v2\n {4}replaces \[1\]/);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/ac-secrets-skipped] [spec:local-search/private-key-skipped] never reads keys, env files or ignored folders", async () => {
    const box = sandbox({
      "README.md": "# Readme\n\nThe token lives in the vault.\n",
      ".env": "TOKEN=vault-token-123\n",
      id_rsa: "vault-token-123\n",
      "deploy/key.txt": "-----BEGIN OPENSSH PRIVATE KEY-----\nvault-token-123\n",
      "node_modules/x/README.md": "vault-token-123\n",
      "build/out.md": "vault-token-123\n",
      "secret-stuff/notes.md": "vault-token-123\n",
      ".gitignore": "secret-stuff/\n*.log\n",
      "debug.log": "vault-token-123\n",
    });
    try {
      assert.deepEqual(listFolder(box.dir).files.map((f) => f.slice(box.dir.length + 1)), ["README.md", "deploy/key.txt"]);
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add(".");
      const out = await g.find("vault token 123");
      assert.doesNotMatch(textOf(out), /vault-token-123/);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/ac-note] [spec:local-search/notes-are-the-persons] finds a note with its date, and an edited note as edited", async () => {
    const box = sandbox({ "docs/oncall.md": ONCALL });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add("docs");
      const kept = g.remember("Escalate to Priya now, Dana moved teams");
      const out = await g.find("who do I escalate to?");
      const note = out.results.find((r) => r.path === kept.path);
      assert.ok(note, "the note is an answer");
      assert.ok(note.facts.some((f) => /^noted \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(f)));
      writeFileSync(kept.path, readFileSync(kept.path, "utf8").replace("Priya", "Omar"));
      assert.match(textOf(await g.find("who do I escalate to?")), /Omar/);
      assert.throws(() => g.forget(kept.path), /Notes are a file/);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/no-text-stored] [spec:local-search/file-is-anchor] keeps sealed places and digests, never the text", async () => {
    const box = sandbox({ "docs/deploy.md": DEPLOY.replace("Tuesday", "Tuesday zebra-unique-77") });
    try {
      const g = createLocal({ home: box.home, secret: "s", userId: "me", cwd: box.dir });
      await g.add("docs");
      await g.find("zebra unique");
      const raw = readFileSync(join(box.home, "local.json"), "utf8");
      assert.doesNotMatch(raw, /zebra-unique-77|deploy\.md/);
      const opened = JSON.stringify(cipher("s:me:local").open(JSON.parse(raw).blob));
      assert.doesNotMatch(opened, /zebra-unique-77/);
      const path = join(box.dir, "docs/deploy.md");
      const anchor = Object.values(cipher("s:me:local").open(JSON.parse(raw).blob).anchors)[0];
      assert.equal(anchor.id, recipeId({ workspaceId: "me", tool: FILE_READ, args: { path } }));
      assert.deepEqual(anchor.items, ["Deploy › Staging", "Deploy › Production"]);
    } finally {
      box.done();
    }
  });

  it("[spec:cli/config-private] keeps its config and its store readable by their owner only", async () => {
    const box = sandbox({ "docs/deploy.md": DEPLOY });
    try {
      const g = createLocal({ home: box.home, cwd: box.dir });
      await g.add("docs");
      for (const file of ["config.json", "local.json"]) assert.equal(statSync(join(box.home, file)).mode & 0o777, 0o600, file);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/first-search-adds-folder] adds the current folder when nothing is added, and says so", async () => {
    const box = sandbox({ "docs/deploy.md": DEPLOY });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      const out = await g.find("production day");
      assert.equal(out.added.source.place, box.dir);
      assert.equal(out.added.new, true);
      assert.match(out.results[0].text, /Thursday/);
      const again = await g.find("production day");
      assert.equal(again.added, undefined);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/sections] gives at most two sections of one place and the limit asked", async () => {
    const many = Array.from({ length: 6 }, (_, i) => `## Pooler ${i}\n\nThe pooler setting ${i}.\n`).join("\n");
    const box = sandbox({ "a.md": `# A\n\n${many}`, "b.md": "# B\n\nThe pooler of b.\n", "c.md": "# C\n\nThe pooler of c.\n" });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add(".");
      const out = await g.find("pooler", { limit: 4 });
      assert.equal(out.results.length, 4);
      assert.equal(out.results.filter((r) => r.path.endsWith("a.md")).length, 2);
    } finally {
      box.done();
    }
  });

  it("[spec:local-search/semantic-opt-in] fuses a ranking by vectors when embeddings are given", async () => {
    // Vectors by topic: a question in Russian shares no word with the English doc but its vector is close.
    const topic = (t) => (/escalat|эскал|page|дежур/i.test(t) ? [1, 0, 0] : /deploy|выкат/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
    const embed = async (texts) => texts.map(topic);
    const box = sandbox({ "docs/deploy.md": DEPLOY, "docs/oncall.md": ONCALL });
    try {
      const words = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await words.add("docs");
      assert.equal((await words.find("кому эскалировать ночью?")).results.length, 0);
      const meaning = createLocal({ home: box.home, secret: "s", cwd: box.dir, embed });
      const out = await meaning.find("кому эскалировать ночью?");
      assert.equal(out.semantic, true);
      assert.ok(out.results[0].path.endsWith("oncall.md"));
    } finally {
      box.done();
    }
  });
});

describe("local search: forget", () => {
  it("[spec:local-search/forget] drops the source and its anchors", async () => {
    const box = sandbox({ "docs/deploy.md": DEPLOY, "other/oncall.md": ONCALL });
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      await g.add("docs");
      await g.add("other");
      const out = g.forget("other");
      assert.equal(out.removed, 1);
      assert.equal(out.source.place, "other");
      assert.deepEqual(g.sources().map((s) => s.place), ["docs"]);
      assert.doesNotMatch(textOf(await g.find("escalate on-call")), /Dana/);
      assert.throws(() => g.forget("nowhere"), /Not a source/);
    } finally {
      box.done();
    }
  });
});

describe("local search: websites", () => {
  it("[spec:local-search/reads-again] reads a saved page again when its words fit, and marks a removed page gone", async () => {
    const site = "https://93.184.215.14/docs/";
    const pages = {
      "/docs/": '<html><head><title>Docs</title></head><body><h1>Docs</h1><p>Start here.</p><a href="/docs/limits">Limits</a></body></html>',
      "/docs/limits": "<html><head><title>Limits</title></head><body><h1>Limits</h1><p>The API allows 600 requests a minute.</p></body></html>",
    };
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
      const html = pages[u.pathname];
      return html == null ? new Response("no", { status: 404 }) : new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    };
    const box = sandbox({});
    try {
      const g = createLocal({ home: box.home, secret: "s", cwd: box.dir });
      const added = await g.add(site);
      assert.equal(added.places, 2);
      pages["/docs/limits"] = pages["/docs/limits"].replace("600", "900");
      const out = await g.find("how many API requests a minute?");
      assert.match(out.results[0].text, /900 requests/);
      assert.equal(out.results[0].place, "https://93.184.215.14/docs/limits");
      assert.deepEqual(out.changes, [{ place: "https://93.184.215.14/docs/limits", event: "changed" }]);
      delete pages["/docs/limits"];
      const gone = await g.find("how many API requests a minute?");
      assert.deepEqual(gone.changes, [{ place: "https://93.184.215.14/docs/limits", event: "gone" }]);
      assert.equal(gone.results.some((r) => r.url === "https://93.184.215.14/docs/limits"), false);
    } finally {
      globalThis.fetch = original;
      box.done();
    }
  });
});

describe("the genter command", () => {
  // The package as installed: bin, src and package.json with no node_modules anywhere above it.
  function installed() {
    const base = mkdtempSync(join(tmpdir(), "genter-bin-"));
    for (const part of ["bin", "src", "package.json"]) cpSync(join(root, part), join(base, "pkg", part), { recursive: true });
    mkdirSync(join(base, "project/docs"), { recursive: true });
    writeFileSync(join(base, "project/docs/deploy.md"), DEPLOY);
    const env = { PATH: process.env.PATH, HOME: join(base, "home"), GENTER_HOME: join(base, "home/.genter") };
    const run = (...args) => spawnSync(process.execPath, [join(base, "pkg/bin/genter.js"), ...args], { cwd: join(base, "project"), env, encoding: "utf8" });
    return { run, done: () => rmSync(base, { recursive: true, force: true }) };
  }

  it("[spec:local-search/ac-no-keys] [spec:cli/no-packages] asks with no key and no package", () => {
    const pkg = installed();
    try {
      const out = pkg.run("ask", "which", "day", "does", "production", "ship?");
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /^\[1\] docs\/deploy\.md:7-9 · Deploy › Production/m);
      assert.match(out.stderr, /added as a source/);
      const json = JSON.parse(pkg.run("ask", "production", "--json").stdout);
      assert.equal(json.results[0].lines[0], 7);
    } finally {
      pkg.done();
    }
  });

  it("[spec:cli/ac-app-no-packages] [spec:cli/app-packages] names the two packages an app command needs", () => {
    const pkg = installed();
    try {
      const out = pkg.run("search", '{"query":"x"}');
      assert.equal(out.status, 1);
      assert.match(out.stderr, /npm i -g @composio\/core zod/);
    } finally {
      pkg.done();
    }
  });

  it("[spec:cli/help] [spec:cli/output-local] lists the local commands first and fails on an unknown one", () => {
    const pkg = installed();
    try {
      const help = pkg.run();
      assert.equal(help.status, 0);
      assert.ok(help.stdout.indexOf("genter ask") < help.stdout.indexOf("genter run"));
      assert.match(help.stdout.trim().split("\n").at(-1), /https:\/\/genter\.ai$/);
      const bad = pkg.run("nope");
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /Unknown command: nope/);
      assert.equal(pkg.run("ask").status, 1);
    } finally {
      pkg.done();
    }
  });
});
