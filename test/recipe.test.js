import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { areaOf, canonicalArgs, classifyFailure, contentHash, isPartial, normalizeLegacy, publicRecipe, recipeId, sourceOf } from "../src/recipe.js";

describe("canonicalArgs", () => {
  it("sorts keys recursively and drops undefined, null and empty strings", () => {
    assert.equal(JSON.stringify(canonicalArgs({ b: 1, a: { z: "x", y: null, w: "", v: undefined }, c: "  hi  " })), '{"a":{"z":"x"},"b":1,"c":"hi"}');
  });
  it("keeps numbers, zero, false and placeholders as written", () => {
    assert.deepEqual(canonicalArgs({ n: 0, ok: false, since: "{{today}}" }), { n: 0, ok: false, since: "{{today}}" });
  });
  it("keeps array order, except primitive sets under *ids / *labels / *tags (sorted, deduped)", () => {
    assert.deepEqual(canonicalArgs({ steps: ["b", "a"], label_ids: ["b", "a", "b"], tags: ["z", "y"], ids: [3, 1, 2] }), { steps: ["b", "a"], label_ids: ["a", "b"], tags: ["y", "z"], ids: [1, 2, 3] });
    assert.deepEqual(canonicalArgs({ ids: [{ id: 2 }, { id: 1 }] }), { ids: [{ id: 2 }, { id: 1 }] }); // objects keep their order
  });
});

describe("recipeId", () => {
  const base = { workspaceId: "w", scope: "ca_1", tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } };
  it("is deterministic and independent of arg order and empty args", () => {
    const id = recipeId(base);
    assert.match(id, /^rcp_[0-9a-f]{24}$/);
    assert.equal(recipeId({ ...base, args: { repo: "r", owner: "o", page: "" } }), id);
  });
  it("differs by workspace, account, tool and args", () => {
    const id = recipeId(base);
    for (const change of [{ workspaceId: "w2" }, { scope: "ca_2" }, { scope: "" }, { tool: "GITHUB_LIST_ISSUES" }, { args: { owner: "o", repo: "x" } }]) {
      assert.notEqual(recipeId({ ...base, ...change }), id);
    }
  });
});

describe("contentHash", () => {
  it("ignores key order, CRLF, outer whitespace and volatile bookkeeping", () => {
    const a = { b: "line1\r\nline2 ", a: [1, 2], etag: "W/1", html_url: "https://x/1?token=a", headers: { date: "1" }, next_page_token: "p1" };
    const b = { a: [1, 2], b: "line1\nline2", etag: "W/2", html_url: "https://x/1?token=b", headers: { date: "2" }, next_page_token: "p2" };
    assert.equal(contentHash(a), contentHash(b));
  });
  it("decodes base64 file content, so a re-encoding is no change, and a real edit is one", () => {
    const file = (text, wrap) => ({ content: { sha: "s", encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{8})/g, wrap ? "$1\n" : "$1") } });
    assert.equal(contentHash(file("hello world, hello", false)), contentHash(file("hello world, hello", true)));
    assert.notEqual(contentHash(file("hello world, hello", false)), contentHash(file("hello world, bye", false)));
  });
  it("changes when the content changes, and treats arrays as ordered", () => {
    assert.notEqual(contentHash({ items: [1, 2] }), contentHash({ items: [2, 1] }));
    assert.notEqual(contentHash({ items: [1] }), contentHash({ items: [1, 2] }));
    assert.equal(contentHash(undefined), contentHash(null));
  });
});

describe("isPartial", () => {
  it("sees next-page tokens, has_more and truncated, nested too", () => {
    assert.equal(isPartial({ items: [], nextPageToken: "abc" }), true);
    assert.equal(isPartial({ data: { has_more: true } }), true);
    assert.equal(isPartial({ truncated: true }), true);
    assert.equal(isPartial({ data: { response_data: { next_cursor: "c" } } }), true);
  });
  it("does not see a finished list", () => {
    assert.equal(isPartial({ items: [{ id: 1 }], next_page_token: null, has_more: false }), false);
    assert.equal(isPartial("text"), false);
  });
});

describe("classifyFailure", () => {
  it("gone: what the call points to is missing", () => {
    for (const e of ["Not Found (404)", { message: "Resource does not exist" }, "HTTP 410 Gone", "The thread was deleted"]) assert.equal(classifyFailure(e), "gone", JSON.stringify(e));
  });
  it("denied: forbidden, unauthorized, revoked or missing connection", () => {
    for (const e of ["403 Forbidden", "Resource not accessible by integration", "401 Unauthorized", "Connected account not found", "invalid_grant: Token has been revoked", "Insufficient permission"]) assert.equal(classifyFailure(e), "denied", e);
  });
  it("null: transient or argument errors never change an anchor", () => {
    for (const e of ["request timed out", "429 rate limit exceeded", "Internal Server Error 500", "Invalid argument: limit must be a number", "", null, undefined]) assert.equal(classifyFailure(e), null, String(e));
  });
});

describe("sourceOf", () => {
  it("finds provenance from generic arg names and a link in the result", () => {
    const s = sourceOf({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "Genterai", repo: "genter", path: "src/auth.ts", ref: "{{today}}" }, data: { html_url: "https://github.com/Genterai/genter/blob/main/src/auth.ts" } });
    assert.deepEqual(s, { app: "GitHub", path: ["Genterai", "genter", "src/auth.ts"], url: "https://github.com/Genterai/genter/blob/main/src/auth.ts" });
  });
  it("works for another app with channel / folder args, and has no url without a link", () => {
    assert.deepEqual(sourceOf({ tool: "SLACK_FETCH_HISTORY", args: { channel: "C1" }, data: { messages: [] } }), { app: "Slack", path: ["C1"], url: null });
    assert.equal(sourceOf({ tool: "X_Y", toolkit: "googledrive", args: { folder_id: "f1" } }).app, "Google Drive");
    assert.equal(sourceOf({ tool: "X_Y", args: {}, data: { url: "https://api.github.com/x" } }).url, null); // an API endpoint is no link people open
  });
});

describe("normalizeLegacy", () => {
  const old = { id: "uuid-1", tool: "GMAIL_FETCH_EMAILS", args: { q: "x" }, created_at: "2026-01-01T00:00:00Z", digest: "d", summary: "s", summaryEmbedding: [1], memory: { description: "### Unread emails\nbody", short: "Unread", status: "valid", created_at: "2026-01-02T00:00:00Z", embedding: [1], account: "ca_1" } };
  it("maps memory.description to title / short and keeps the summary and embeddings", () => {
    const r = normalizeLegacy(old);
    assert.equal(r.title, "Unread emails");
    assert.equal(r.short, "Unread");
    assert.equal(r.summary, "s");
    assert.deepEqual(r.summaryEmbedding, [1]);
    assert.equal(r.status, "fresh");
    assert.deepEqual(r.scope, { account: "ca_1", toolkit: "gmail" });
    assert.equal(r.memory, undefined);
    assert.equal(r.legacy, true);
  });
  it("outdated becomes stale, disabled stays", () => {
    const r = normalizeLegacy({ ...old, memory: { ...old.memory, status: "outdated", disabled: "2026" } });
    assert.equal(r.status, "stale");
    assert.equal(r.disabled, "2026");
  });
  it("drops aliases, sync records, live plans and never-anchors", () => {
    assert.equal(normalizeLegacy({ id: "a", alias: "b" }), null);
    assert.equal(normalizeLegacy({ ...old, kind: "sync" }), null);
    assert.equal(normalizeLegacy({ id: "x", tool: "T", args: {}, summary: "s" }), null);
    assert.equal(normalizeLegacy({ id: "x", removed: true }), null);
    assert.equal(normalizeLegacy({ ...old, live: { list: {} } }).live, undefined);
  });
  it("passes a current record through and publicRecipe strips vectors", () => {
    const now = { id: "rcp_1", tool: "T", args: {}, scope: { account: "", toolkit: "t" }, status: "gone", summaryEmbedding: [1], itemEmbeddings: [[1]] };
    assert.equal(normalizeLegacy(now), now);
    assert.deepEqual(publicRecipe(now), { id: "rcp_1", tool: "T", args: {}, scope: { account: "", toolkit: "t" }, status: "gone" });
  });
});

describe("areaOf", () => {
  it("finds the repository a GitHub call reads in, whatever file or page of it", () => {
    const repo = { id: "Genterai/specs", label: "Genterai/specs", kind: "repository", where: { owner: "Genterai", repo: "specs" } };
    assert.deepEqual(areaOf({ args: { owner: "Genterai", repo: "specs", path: "README.md" } }), repo);
    assert.deepEqual(areaOf({ args: { owner: "Genterai", repo: "specs", per_page: 5, sha: "main" } }), repo);
  });
  it("names other containers by their arg names, the innermost one being the area", () => {
    assert.deepEqual(areaOf({ args: { calendarId: "primary", timeMin: "{{today}}" } }), { id: "primary", label: "primary", kind: "calendar", where: { calendarId: "primary" } });
    assert.equal(areaOf({ args: { channel: "C123", limit: 20 } }).kind, "channel");
    assert.equal(areaOf({ args: { folder_id: "1AbC" } }).kind, "folder");
    const teams = areaOf({ args: { team_id: "T1", channel_id: "C9" } });
    assert.equal(teams.kind, "channel");
    assert.deepEqual(teams.where, { team_id: "T1", channel_id: "C9" });
    assert.equal(teams.id, "T1/C9");
  });
  it("an owner, a workspace or a search over the whole app is no area", () => {
    assert.equal(areaOf({ args: { owner: "Genterai" } }), null);
    assert.equal(areaOf({ args: { query: "is:unread", max_results: 10 } }), null);
    assert.equal(areaOf({ args: { repo: "{{repo}}" } }), null);
    assert.equal(areaOf(), null);
  });
  it("finds the folder a found file sits in from the result, and none when the files are in several", () => {
    const one = areaOf({ args: { q: "name contains 'plan'" }, data: { files: [{ id: "f1", name: "Q3 plan", parents: ["fold1"] }] } });
    assert.deepEqual(one, { id: "fold1", label: "folder of “Q3 plan”", kind: "folder", where: { folder_id: "fold1" } });
    const same = areaOf({ args: {}, data: { files: [{ id: "a", parents: ["fold1"] }, { id: "b", parents: ["fold1"] }] } });
    assert.equal(same.id, "fold1");
    assert.equal(same.label, "fold1");
    assert.equal(areaOf({ args: {}, data: { files: [{ id: "a", parents: ["x"] }, { id: "b", parents: ["y"] }] } }), null);
    assert.equal(areaOf({ args: {}, data: { results: [{ id: "p", parent: { type: "database_id", database_id: "db1" } }] } }).kind, "database");
    assert.equal(areaOf({ args: {}, data: { messages: [{ id: "m1", subject: "hi" }] } }), null);
  });
  it("long ids are cut in the label, never in id or where", () => {
    const long = "1".repeat(40);
    const a = areaOf({ args: { folder_id: long } });
    assert.equal(a.id, long);
    assert.equal(a.where.folder_id, long);
    assert.equal(a.label, `${"1".repeat(12)}…`);
  });
});
