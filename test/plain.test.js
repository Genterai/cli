import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAIN, plainDescription, plainName, plainSections, plainText } from "../src/plain.js";

const b64 = (text) => Buffer.from(text).toString("base64");

describe("plain reads: an area's item described from its own text, with no model", () => {
  it("P1 [spec:area-listing/plain-text] a file's base64 content is its text; a note's fields are written as Markdown", () => {
    const file = plainText({ path: "docs/a.md", sha: "1", content: b64("# Deploy\n\nRun make ship."), encoding: "base64" });
    assert.equal(file.document, true);
    assert.equal(file.text, "# Deploy\n\nRun make ship.");
    const note = plainText({ id: "n1", title: "Groceries", labels: ["home"], created: "2026-10-01" });
    assert.equal(note.document, false);
    assert.match(note.text, /Groceries/);
  });

  it("P2 [spec:area-listing/plain-sections] Markdown is cut by heading, code in blocks at blank lines, at most 100", () => {
    const md = plainSections("README.md", "# Genter\n\nIntro.\n\n## Install\n\nnpm i\n\n## Deploy\n\nmake ship\n");
    assert.deepEqual(md.map((s) => s.headings.join(" › ")), ["Genter", "Genter › Install", "Genter › Deploy"]);
    const code = plainSections("src/app.py", `# a comment, not a heading\n${"x = 1\n".repeat(300)}\n\n${"y = 2\n".repeat(300)}`);
    assert.ok(code.length >= 2);
    assert.ok(code.every((s) => s.headings.length === 0));
    const many = plainSections("big.md", Array.from({ length: 150 }, (_, i) => `## S${i}\n\ntext ${i}\n`).join("\n"));
    assert.equal(many.length, PLAIN.sections);
  });

  it("P3 [spec:area-listing/plain-description] title from the first heading, else the name; summary names the place and headings", () => {
    const out = plainDescription({
      tool: "GITHUB_GET_REPOSITORY_CONTENT",
      args: { owner: "o", repo: "r", path: "docs/deploy.md" },
      data: { content: b64("# Deploying Genter\n\nThe pooler listens on port 6432.\n\n## Rollback\n\nRun make rollback.\n"), encoding: "base64" },
    });
    assert.equal(out.title, "Deploying Genter");
    assert.match(out.summary, /^File "docs\/deploy\.md" \(github\)\. Headings: Deploying Genter; Rollback\./);
    assert.match(out.summary, /port 6432/);
    assert.deepEqual(out.items, ["Deploying Genter: The pooler listens on port 6432.", "Deploying Genter › Rollback: Run make rollback."]);
    assert.equal(out.embed.length, out.items.length);
    assert.match(out.embed[1], /^deploy\.md › Deploying Genter › Rollback\n/);
    assert.ok(out.keywords.includes("deploy.md") && out.keywords.includes("docs") && out.keywords.includes("rollback"));
    const bare = plainDescription({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { path: "src/server.js" }, data: { content: b64("const a = 1;\n"), encoding: "base64" } });
    assert.equal(bare.title, "server.js");
  });

  it("P4 the name comes from the args, else from the result", () => {
    assert.equal(plainName({ owner: "o", repo: "r", path: "a/b.md" }), "a/b.md");
    assert.equal(plainName({ file_id: "1x" }, { data: { name: "Roadmap" } }), "Roadmap");
    assert.equal(plainName({ file_id: "1x" }, {}), "1x");
  });
});
