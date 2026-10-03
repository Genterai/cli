import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createGenter } from "../src/genter.js";

// The real createGenter on a Composio stand-in: tool calls are answered over fetch, so execute runs its own code
// (the agent tests replace genter as a whole and never reach it).
let restore;
afterEach(() => restore?.());

function fakeComposio(data) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/tools/execute/")) return json({ data, successful: true, error: null, log_id: "l1" });
    if (u.includes("/tools/")) return json({ slug: u.split("/").pop().split("?")[0], name: "Tool", description: "", toolkit: { slug: "github", name: "GitHub", logo: "" }, input_parameters: {}, output_parameters: {}, tags: [], version: "1", available_versions: ["1"], scopes: [], no_auth: false, is_deprecated: false, deprecated: { displayName: "", version: "1", available_versions: ["1"], is_deprecated: false, toolkit: { logo: "" } } });
    return json({ items: [] });
  };
  restore = () => (globalThis.fetch = original);
  return calls;
}

const memoryStore = () => {
  const rows = new Map();
  return { rows, get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), all: async () => [...rows.values()] };
};

describe("genter.execute", () => {
  it("G1 a call that is saved as a recipe returns its result and an id (remember is not shadowed)", async () => {
    const calls = fakeComposio({ commits: [{ sha: "c1", commit: { message: "m" } }] });
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } });
    assert.equal(out.result.successful, true);
    assert.deepEqual(out.result.data, { commits: [{ sha: "c1", commit: { message: "m" } }] });
    assert.ok(out.id);
    assert.ok(store.rows.has(out.id));
    assert.ok(calls.some((u) => u.includes("/tools/execute/GITHUB_LIST_COMMITS")));
    await Promise.all(deferred);
  });

  it("G2 remember: false runs it without saving it", async () => {
    fakeComposio({ content: { content: "YQ==", encoding: "base64" } });
    const store = memoryStore();
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: () => {} });
    const out = await genter.execute({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path: "a" }, remember: false });
    assert.equal(out.result.successful, true);
    assert.equal(out.id, undefined);
    assert.equal(store.rows.size, 0);
  });
});
