import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { areaStats, driftFacts, sourceDates, sourceCount, supersededOf } from "../src/drift.js";
import { recipesResultText } from "../src/tools.js";
import { createGenter } from "../src/genter.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");

describe("Anchor Drift: source dates", () => {
  it("reads modified and created dates by field name, whatever the connector", () => {
    assert.deepEqual(sourceDates({ modifiedTime: "2019-03-02T10:00:00Z", createdTime: "2018-01-01T00:00:00Z" }, { now: NOW }), { source_at: "2019-03-02T10:00:00.000Z", source_created_at: "2018-01-01T00:00:00.000Z" });
    for (const key of ["modified_time", "updated_at", "updatedAt", "last_edited_time", "lastModified", "last_modified"]) {
      assert.equal(sourceDates({ [key]: "2020-05-05T00:00:00Z" }, { now: NOW }).source_at, "2020-05-05T00:00:00.000Z", key);
    }
  });
  it("a commit's committer date counts; a list takes its freshest item", () => {
    assert.equal(sourceDates([{ commit: { committer: { date: "2021-01-01T00:00:00Z" } } }, { commit: { committer: { date: "2024-06-01T00:00:00Z" } } }], { now: NOW }).source_at, "2024-06-01T00:00:00.000Z");
  });
  it("a site's Last-Modified header is a date; nothing found, nothing returned; bad and future dates are ignored", () => {
    assert.equal(sourceDates({ text: "x" }, { lastModified: "Tue, 05 Mar 2019 10:00:00 GMT", now: NOW }).source_at, "2019-03-05T10:00:00.000Z");
    assert.deepEqual(sourceDates({ title: "x", date_label: "soon" }, { now: NOW }), {});
    assert.deepEqual(sourceDates({ updated_at: "2031-01-01T00:00:00Z", modified: "not a date" }, { now: NOW }), {});
  });
});

describe("Anchor Drift: replaced marks", () => {
  it("finds a mark at the top of a document, with its link", () => {
    assert.deepEqual(supersededOf({ title: "Old guide", text: "> This page is deprecated. See https://docs.example.com/new for the current guide.\n\nSteps..." }), { marker: "deprecated", by: "https://docs.example.com/new" });
    assert.deepEqual(supersededOf({ title: "[DEPRECATED] Old API", text: "x" }), { marker: "deprecated" });
    assert.equal(supersededOf({ text: "Superseded by https://x.io/v2\nbody" }).by, "https://x.io/v2");
    assert.equal(supersededOf({ text: "Этот документ устарел, актуальный: https://wiki/new" }).marker, "устарел");
    assert.equal(supersededOf({ text: "Moved to https://new.example.com/page" }).marker, "moved to");
    assert.equal(supersededOf({ text: "This project is no longer maintained.\n" }).marker, "no longer maintained");
  });
  it("an archived flag counts", () => {
    assert.deepEqual(supersededOf({ name: "repo", archived: true }), { marker: "archived" });
  });
  it("does not fire on a word deep in a long document, in a function, or in a list", () => {
    const body = `# Guide\n\nIntro line.\n\nSecond paragraph.\n\nThird.\n\nFourth.\n\n${"filler text. ".repeat(40)}\n\nThe old helper is deprecated and replaced by newHelper().`;
    assert.equal(supersededOf({ title: "Guide", text: body }), null);
    assert.equal(supersededOf({ title: "API", text: "## deprecate_user()\nRemoves a user." }), null);
    assert.equal(supersededOf({ title: "Notes on deprecated API handling", text: "How we handle them." }), null);
    assert.equal(supersededOf({ text: "Call `deprecated(x)` to mark it." }), null);
    assert.equal(supersededOf({ text: "Moved to Trash is a folder label" }), null);
    assert.equal(supersededOf([{ text: "This is deprecated." }, { text: "fine" }]), null);
    assert.equal(supersededOf({ text: `${"This long paragraph talks about many things and says it is deprecated somewhere. ".repeat(6)}` }), null);
  });
});

describe("Anchor Drift: facts only on deviation", () => {
  const old = { source_at: "2019-03-10T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
  const fresh = { source_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" };
  it("an old source next to fresh ones in the same answer", () => {
    assert.deepEqual(driftFacts(old, [old, fresh], { now: NOW }), ["source last changed 2019-03; another source in this answer changed within the last 30 days"]);
  });
  it("says nothing when nothing deviates", () => {
    assert.deepEqual(driftFacts(fresh, [old, fresh], { now: NOW }), []); // fresh itself
    assert.deepEqual(driftFacts(old, [old], { now: NOW }), []); // old, but nothing around it is fresh
    assert.deepEqual(driftFacts(old, [old, { source_at: "2019-05-01T00:00:00Z" }], { now: NOW }), []); // everything is old
    assert.deepEqual(driftFacts({ updated_at: "2026-09-01T00:00:00Z" }, [fresh], { now: NOW }), []);
    assert.deepEqual(driftFacts(undefined, [], { now: NOW }), []);
  });
  it("area statistics: most of the area changed lately", () => {
    const area = { ...old, area_stats: { items: 16, recent: 14, days: 90 } };
    assert.deepEqual(driftFacts(area, [area], { now: NOW }), ["source last changed 2019-03; 14 of 16 items in this area changed in the last 90 days"]);
    assert.deepEqual(driftFacts({ ...old, area_stats: { items: 16, recent: 2, days: 90 } }, [], { now: NOW }), []);
    assert.deepEqual(driftFacts({ ...old, area_stats: { items: 3, recent: 3, days: 90 } }, [], { now: NOW }), []); // too small an area
  });
  it("a replaced mark is shown even when the date is fine", () => {
    assert.deepEqual(driftFacts({ ...fresh, superseded: { marker: "deprecated", by: "https://x.io/new" } }, [], { now: NOW }), ["marked as replaced: https://x.io/new"]);
    assert.deepEqual(driftFacts({ superseded: { marker: "redirect", by: "https://x.io/b" } }, [], { now: NOW }), ["address now redirects to https://x.io/b"]);
  });
  it("area stats from listed versions", () => {
    const s = areaStats(["2026-09-30T00:00:00Z", "2026-08-01T00:00:00Z", "2019-01-01T00:00:00Z", "", "abc"], { now: NOW });
    assert.equal(s.items, 3);
    assert.equal(s.recent, 2);
    assert.equal(s.median, "2026-08-01T00:00:00.000Z");
    assert.equal(areaStats(["", "v1"], { now: NOW }), null);
  });
});

describe("Anchor Drift: the answer", () => {
  const r = (id, signals, extra = {}) => ({ id, tool: "T", args: {}, data: { x: 1 }, signals, ...extra });
  const old = { source_at: "2019-03-10T00:00:00Z", updated_at: new Date().toISOString(), source: "github/a/r1" };
  const fresh = { source_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), updated_at: new Date().toISOString(), source: "notion/b/" };
  it("the Anchor line is unchanged without a deviation, and gets one bracketed fact with it", () => {
    const plain = recipesResultText({ status: "done", results: [r("rcp_1", fresh), r("rcp_2", undefined)] });
    assert.match(plain, /^Anchor 1: rcp_1 · T · saved path\n/);
    assert.match(plain, /\nAnchor 2: rcp_2 · T · saved path\n/);
    const text = recipesResultText({ status: "done", results: [r("rcp_1", old, { title: "Guide" }), r("rcp_2", fresh)] });
    assert.match(text, /^Anchor 1: rcp_1 · T — Guide · saved path \[source last changed 2019-03; another source in this answer changed within the last 30 days\]\n/);
    assert.match(text, /\nAnchor 2: rcp_2 · T · saved path\n/);
  });
  it("two or more different sources add one instruction line; one source adds none", () => {
    const meta = (t) => JSON.parse(t.slice(t.lastIndexOf("\n") + 1));
    assert.equal(meta(recipesResultText({ status: "done", results: [r("a", old), r("b", fresh)] })).instructions, "These results come from 2 different sources. Compare them before answering and tell the user if they disagree.");
    assert.equal(meta(recipesResultText({ status: "done", results: [r("a", old), r("b", { ...old })] })).instructions, undefined);
    assert.equal(sourceCount([r("a", old), r("b", fresh), r("c", undefined)]), 2);
  });
});

describe("Anchor Drift: execute stores the signals", () => {
  let restore;
  afterEach(() => restore?.());
  const store = () => {
    const rows = new Map();
    return { rows, get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), all: async () => [...rows.values()].filter((x) => x.remembered), remove: async (id) => rows.delete(id) };
  };
  const compose = (data) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/tools/execute/")) return json({ data: data(), successful: true, error: null, log_id: "l" });
      if (u.includes("/tools/")) return json({ slug: "T", name: "T", description: "", toolkit: { slug: "drive", name: "Drive", logo: "" }, input_parameters: {}, output_parameters: {}, tags: [], version: "1", available_versions: ["1"], scopes: [], no_auth: false, is_deprecated: false, deprecated: { displayName: "", version: "1", available_versions: ["1"], is_deprecated: false, toolkit: { logo: "" } } });
      return json({ items: [] });
    };
    restore = () => (globalThis.fetch = original);
  };
  it("saves source_at without changing the digest, and returns signals", async () => {
    const body = { files: [{ id: "f", name: "Spec", modifiedTime: "2019-03-02T10:00:00Z" }] };
    compose(() => body);
    const s = store();
    const genter = createGenter({ composioApiKey: "k", workspaceId: "w", userId: "u", secret: "s", store: s, defer: () => {} });
    const out = await genter.execute({ tool: "GOOGLEDRIVE_FIND_FILE", args: { q: "x" } });
    assert.equal(out.signals.source_at, "2019-03-02T10:00:00.000Z");
    const first = await genter.recipes.get(out.id);
    assert.equal(first.source_at, "2019-03-02T10:00:00.000Z");
    const digest = first.digest;
    const again = await genter.execute({ tool: "GOOGLEDRIVE_FIND_FILE", args: { q: "x" } });
    assert.equal(again.unchanged, true);
    assert.equal((await genter.recipes.get(out.id)).digest, digest);
    assert.equal(again.signals.updated_at, first.updated_at);
  });
  it("marks a replaced document from its text, no model", async () => {
    compose(() => ({ title: "Setup", text: "DEPRECATED: use https://docs.x.io/new instead.\n\nOld steps." }));
    const genter = createGenter({ composioApiKey: "k", workspaceId: "w", userId: "u", secret: "s", store: store(), defer: () => {} });
    const out = await genter.execute({ tool: "NOTION_FETCH_DATA", args: { id: "1" } });
    assert.deepEqual(out.signals.superseded, { marker: "deprecated", by: "https://docs.x.io/new" });
  });
});
