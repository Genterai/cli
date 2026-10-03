import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { READY } from "../src/ready.js";
import { shapeRef, writeHints } from "../src/refs.js";
import { createSources } from "../src/sync.js";

// Sources in memory, no encryption: what the hosted backend keeps in Postgres.
function memoryKnowledge() {
  const sources = new Map();
  const items = new Map();
  return {
    getSource: async (id) => sources.get(id),
    putSource: async (row) => sources.set(row.id, row),
    deleteSource: async (id) => sources.delete(id),
    sources: async () => [...sources.values()],
    items: async (sourceId) => [...items.values()].filter((r) => r.source_id === sourceId),
    putItems: async (rows) => rows.forEach((r) => items.set(`${r.source_id}:${r.key}`, r)),
    deleteItems: async (sourceId, keys) => keys.forEach((k) => items.delete(`${sourceId}:${k}`)),
    allItems: async () => [...items.values()],
  };
}

// Embeddings by topic words, so a query finds the chunk that talks about it.
const TOPICS = ["paging", "rounding", "rent", "readme"];
const vectorOf = (text) => [...TOPICS.map((t) => (String(text).toLowerCase().includes(t) ? 1 : 0)), 0.05];

function sourcesWith(calls, recipes) {
  return createSources({
    run: async (tool, args) => {
      const out = calls[tool];
      if (!out) throw new Error(`no fake ${tool}`);
      return { successful: true, data: typeof out === "function" ? out(args) : out };
    },
    embedMany: async (texts) => texts.map(vectorOf),
    seal: (v) => JSON.stringify(v),
    open: (b) => JSON.parse(b),
    store: memoryKnowledge(),
    recipes: { get: async (id) => recipes[id] ?? null, list: async () => Object.entries(recipes).map(([id, recipe]) => ({ id, recipe })) },
  });
}

const b64 = (s) => Buffer.from(s).toString("base64");

describe("Knowledge hits say where they are", () => {
  it("S19 a GitHub project synced by its ready recipe: files and issues come back with path, number and where", async () => {
    const repo = { id: 7, full_name: "Genterai/genter-cli", name: "genter-cli", owner: { login: "Genterai" }, default_branch: "main", permissions: { admin: false } };
    const ready = await READY.github.recipes({ run: async () => ({ successful: true, data: { repositories: [repo] } }) });
    const recipe = ready.find((r) => r.key === "repo:7").recipe;
    const sources = sourcesWith(
      {
        GITHUB_GET_A_REPOSITORY: { full_name: "Genterai/genter-cli", description: "Composio tools with recipes", html_url: "https://github.com/Genterai/genter-cli" },
        GITHUB_GET_A_TREE: { tree: [{ path: "src/sync.js", type: "blob", sha: "s1", size: 100 }, { path: "README.md", type: "blob", sha: "s2", size: 50 }] },
        GITHUB_GET_REPOSITORY_CONTENT: ({ path }) => ({ content: { content: b64(path === "README.md" ? "# genter readme" : "// paging stops at a short page"), encoding: "base64" } }),
        GITHUB_LIST_REPOSITORY_ISSUES: { issues: [{ id: 900, node_id: "I_x", number: 42, title: "EU rounding", body: "rounding is off", updated_at: "2026-10-01", html_url: "https://github.com/Genterai/genter-cli/issues/42" }] },
      },
      { repo7: recipe },
    );
    const source = await sources.create({ template: "repo7", scope: {} });
    const synced = await sources.sync({ id: source.id, budgetMs: 10_000 });
    assert.equal(synced.status, "ready", JSON.stringify(synced.last_run));

    const [file] = await sources.search({ vector: vectorOf("paging"), limit: 1 });
    assert.equal(file.toolkit, "github");
    assert.equal(file.part, "files");
    assert.equal(file.item, "src/sync.js");
    assert.equal(file.tool, "GITHUB_GET_A_TREE");
    assert.deepEqual(file.where, { owner: "Genterai", repo: "genter-cli", branch: "main", tree_sha: "main", path: "src/sync.js", sha: "s1" });
    const ref = shapeRef({ app: file.toolkit, via: "knowledge", ...file });
    assert.equal(ref.url, "https://github.com/Genterai/genter-cli/blob/main/src/sync.js");
    assert.deepEqual(writeHints(ref)[0].args, { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" });

    const [issue] = await sources.search({ vector: vectorOf("rounding"), limit: 1 });
    assert.equal(issue.part, "issues");
    assert.equal(issue.item, "42");
    const issueRef = shapeRef({ app: issue.toolkit, via: "knowledge", ...issue });
    assert.equal(issueRef.kind, "issue");
    assert.deepEqual(issueRef.where, { owner: "Genterai", repo: "genter-cli", issue_number: 42 });
  });

  it("S20 Google Tasks synced over every task list: the list a task is in is part of where", async () => {
    const recipe = (await READY.googletasks.recipes({})).find((r) => r.kind === "sync").recipe;
    const sources = sourcesWith(
      {
        GOOGLETASKS_LIST_TASK_LISTS: { items: [{ id: "list1", title: "Home" }] },
        GOOGLETASKS_LIST_TASKS: ({ tasklist_id }) => ({ items: [{ id: "task9", title: "Pay rent", updated: "2026-10-01", tasklist: tasklist_id }] }),
      },
      { tasks: recipe },
    );
    const source = await sources.create({ template: "tasks", scope: {} });
    await sources.sync({ id: source.id, budgetMs: 10_000 });
    const [hit] = await sources.search({ vector: vectorOf("rent"), limit: 1 });
    assert.equal(hit.item, "list1/task9");
    assert.equal(hit.where.tasklist_id, "list1");
    const ref = shapeRef({ app: hit.toolkit, via: "knowledge", ...hit });
    assert.deepEqual(writeHints(ref)[0], { ...writeHints(ref)[0], tool: "GOOGLETASKS_PATCH_TASK", args: { tasklist_id: "list1", task_id: "task9" } });
  });
});
