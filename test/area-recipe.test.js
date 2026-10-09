import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdsText, listingOf, recipeFrom, templated } from "../src/area-recipe.js";

const tree = { required: ["owner", "repo", "tree_sha"], properties: { owner: { type: "string", examples: ["octocat"] }, repo: { type: "string" }, tree_sha: { type: "string", examples: ["main", "master"] }, recursive: { examples: [true, false] } } };
const content = { required: ["owner", "repo", "path"], properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string", examples: ["main"] } } };
const listing = {
  recipe_id: "rcp_tree",
  tool: "GITHUB_GET_A_TREE",
  args: { owner: "acme", repo: "billing", tree_sha: "main", recursive: true },
  read_tool: "GITHUB_GET_REPOSITORY_CONTENT",
  shared_args: { owner: "acme", repo: "billing" },
  item_arg: "path",
  item_field: "path",
  versions: { "a.md": "1" },
};

describe("area recipes: how an app's area is listed and read, kept per app with no data", () => {
  it("K1 [spec:areas/recipe-per-app] the area's own values become placeholders; values the tool offers stay; nothing else is kept", () => {
    const recipe = recipeFrom({ listing, where: { owner: "acme", repo: "billing" }, schemas: { GITHUB_GET_A_TREE: tree, GITHUB_GET_REPOSITORY_CONTENT: content } });
    assert.deepEqual(recipe, {
      list_tool: "GITHUB_GET_A_TREE",
      list_args: { owner: "{{where.owner}}", recursive: true, repo: "{{where.repo}}", tree_sha: "main" },
      read_tool: "GITHUB_GET_REPOSITORY_CONTENT",
      shared_args: { owner: "{{where.owner}}", repo: "{{where.repo}}" },
      item_arg: "path",
      item_field: "path",
    });
    assert.ok(!JSON.stringify(recipe).includes("acme") && !JSON.stringify(recipe).includes("billing"));
  });

  it("K2 a required arg holding data the area does not name makes no recipe; an optional one is dropped", () => {
    const secret = { ...listing, args: { ...listing.args, tree_sha: "release-for-client-x" } };
    assert.equal(recipeFrom({ listing: secret, where: { owner: "acme", repo: "billing" }, schemas: { GITHUB_GET_A_TREE: tree, GITHUB_GET_REPOSITORY_CONTENT: content } }), null);
    const optional = { ...listing, shared_args: { owner: "acme", repo: "billing", ref: "client-x" } };
    assert.deepEqual(recipeFrom({ listing: optional, where: { owner: "acme", repo: "billing" }, schemas: { GITHUB_GET_A_TREE: tree, GITHUB_GET_REPOSITORY_CONTENT: content } }).shared_args, { owner: "{{where.owner}}", repo: "{{where.repo}}" });
    // No area to name: no recipe.
    assert.equal(recipeFrom({ listing, where: {}, schemas: {} }), null);
  });

  it("K3 a query built around the area's id keeps its syntax, not a longer text", () => {
    const where = { folder_id: "1AbCdEf" };
    assert.equal(templated("'1AbCdEf' in parents and trashed = false", where), "'{{where.folder_id}}' in parents and trashed = false");
    assert.equal(templated(`'1AbCdEf' in parents and name contains '${"x".repeat(80)}'`, where), undefined);
    assert.equal(templated("Quarterly plan", where), undefined);
    assert.equal(templated(50, where), 50);
  });

  it("K4 a recipe filled for another area is a listing with no item read yet; a missing value fills nothing", () => {
    const recipe = recipeFrom({ listing, where: { owner: "acme", repo: "billing" }, schemas: { GITHUB_GET_A_TREE: tree, GITHUB_GET_REPOSITORY_CONTENT: content } });
    const next = listingOf(recipe, { owner: "octo", repo: "docs" }, "ca_1");
    assert.deepEqual(next.args, { owner: "octo", recursive: true, repo: "docs", tree_sha: "main" });
    assert.deepEqual(next.shared_args, { owner: "octo", repo: "docs" });
    assert.deepEqual(next.versions, {});
    assert.equal(next.account, "ca_1");
    assert.equal(listingOf(recipe, { owner: "octo" }), null);
  });

  it("K5 [spec:areas/list-is-read] a list holds its items' text when most items carry a long text field", () => {
    const notes = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, body: "word ".repeat(60) }));
    assert.equal(holdsText(notes, "id"), true);
    assert.equal(holdsText(notes.map((n, i) => (i < 4 ? { id: n.id, title: n.title } : n)), "id"), false);
    assert.equal(holdsText([{ path: "a.md", sha: "1", url: `https://x/${"a".repeat(300)}` }], "path"), false);
    assert.equal(holdsText(Array.from({ length: 101 }, () => notes[0]), "id"), false); // more than one anchor keeps
  });
});
