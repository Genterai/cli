import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { addIntent, buildSkill, fileKind, normalizeFiles, parseSkillMd, readZip, referencedFiles, skillVersion, splitMarkdown } from "../src/skills.js";

const file = (path, text) => ({ path, bytes: Buffer.from(text) });

const SKILL = `---
name: pdf-forms
description: >
  Fill and extract PDF forms.
  Use when the user has a PDF form.
---

# PDF forms

Intro text about forms.

## Install

Run \`scripts/install.sh\` first.

\`\`\`bash
# not a heading
pip install pypdf
\`\`\`

## Fill a form

Use [the template](templates/form.json) and see [reference](REFERENCE.md).

### Fields

Field names come from the form.
`;

// A zip with stored or deflated entries, built by hand.
function zip(entries, { deflate = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const raw = Buffer.from(data);
    const body = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("fileKind", () => {
  it("tells markdown, scripts and artifacts apart", () => {
    assert.equal(fileKind("a/b.md"), "markdown");
    assert.equal(fileKind("scripts/run.py"), "script");
    assert.equal(fileKind("scripts/run.SH"), "script");
    assert.equal(fileKind("x/tool", Buffer.from("#!/usr/bin/env bash\necho")), "script");
    assert.equal(fileKind("templates/form.json"), "artifact");
    assert.equal(fileKind("img/logo.png"), "artifact");
    assert.equal(fileKind("fonts/a.woff2"), "artifact");
  });
});

describe("parseSkillMd", () => {
  it("reads front matter, folded values included", () => {
    const m = parseSkillMd(SKILL);
    assert.equal(m.name, "pdf-forms");
    assert.equal(m.description, "Fill and extract PDF forms. Use when the user has a PDF form.");
    assert.ok(m.body.startsWith("\n# PDF forms") || m.body.startsWith("# PDF forms"));
  });
  it("works without front matter", () => {
    const m = parseSkillMd("# Hello\ntext");
    assert.equal(m.name, null);
    assert.equal(m.body, "# Hello\ntext");
  });
});

describe("splitMarkdown", () => {
  const text = parseSkillMd(SKILL);
  const chunks = splitMarkdown("SKILL.md", SKILL, { from: text.bodyStart });
  it("splits by headings, deterministically", () => {
    assert.deepEqual(
      chunks.map((c) => c.id),
      ["SKILL.md#pdf-forms", "SKILL.md#pdf-forms/install", "SKILL.md#pdf-forms/fill-a-form", "SKILL.md#pdf-forms/fill-a-form/fields"],
    );
    assert.deepEqual(splitMarkdown("SKILL.md", SKILL, { from: text.bodyStart }), chunks);
  });
  it("does not split at a # inside a code fence", () => {
    const install = chunks.find((c) => c.title === "Install");
    assert.match(SKILL.slice(install.start, install.end), /pip install pypdf/);
    assert.ok(!chunks.some((c) => c.title === "not a heading"));
  });
  it("keeps the heading path and offsets into the file", () => {
    const fields = chunks.at(-1);
    assert.deepEqual(fields.headings, ["PDF forms", "Fill a form", "Fields"]);
    assert.match(SKILL.slice(fields.start, fields.end), /^### Fields/);
  });
  it("text before the first heading is the introduction; a heading with no text gives no piece", () => {
    const out = splitMarkdown("a.md", "Hello there\n\n# Only\n## Child\nbody\n");
    assert.deepEqual(out.map((c) => [c.id, c.title]), [["a.md#intro", "Introduction"], ["a.md#only/child", "Child"]]);
  });
  it("repeated headings get unique ids", () => {
    const out = splitMarkdown("a.md", "## A\none\n## A\ntwo\n");
    assert.deepEqual(out.map((c) => c.id), ["a.md#a", "a.md#a~2"]);
  });
  it("a long section is cut into parts at blank lines", () => {
    const para = `${"word ".repeat(200)}\n\n`;
    const out = splitMarkdown("a.md", `# Big\n\n${para.repeat(20)}`);
    assert.ok(out.length > 1);
    assert.ok(out.every((c) => c.end - c.start <= 6200));
    assert.ok(out[0].id.endsWith(".p1") && out[0].title === "Big (part 1)");
  });
});

describe("referencedFiles", () => {
  it("resolves links and backticked paths against the skill's files", () => {
    const known = new Set(["scripts/install.sh", "templates/form.json", "docs/a.md", "docs/img/x.png"]);
    const text = "[t](../templates/form.json) ![x](img/x.png) `scripts/install.sh` [web](https://x.io/a.md) `nope.txt`";
    assert.deepEqual(referencedFiles(text, "docs/a.md", known).sort(), ["docs/img/x.png", "scripts/install.sh", "templates/form.json"]);
  });
});

describe("buildSkill / normalizeFiles", () => {
  const files = normalizeFiles([
    file("pdf-forms/SKILL.md", SKILL),
    file("pdf-forms/REFERENCE.md", "# Reference\n\nFields list.\n"),
    file("pdf-forms/scripts/install.sh", "#!/bin/sh\necho hi\n"),
    file("pdf-forms/templates/form.json", "{}"),
    file("pdf-forms/.DS_Store", "x"),
  ]);
  const skill = buildSkill(files);
  it("drops the common top folder and junk, SKILL.md first", () => {
    assert.deepEqual(files.map((f) => f.path), ["SKILL.md", "REFERENCE.md", "scripts/install.sh", "templates/form.json"]);
  });
  it("names the skill from SKILL.md and counts what a project would hold", () => {
    assert.equal(skill.name, "pdf-forms");
    assert.match(skill.description, /Fill and extract/);
    assert.equal(skill.chunks.length, 5);
    assert.deepEqual(skill.recipes, { chunks: 5, files: 2, total: 7 });
  });
  it("a piece lists the scripts and artifacts it points to, and other markdown it points to", () => {
    const install = skill.chunks.find((c) => c.title === "Install");
    assert.deepEqual(install.refs, ["scripts/install.sh"]);
    const fill = skill.chunks.find((c) => c.title === "Fill a form");
    assert.deepEqual(fill.refs, ["templates/form.json"]);
    assert.deepEqual(fill.see, ["REFERENCE.md#reference"]);
  });
  it("scripts are only classified, never executed", () => {
    assert.equal(skill.files.find((f) => f.path === "scripts/install.sh").kind, "script");
  });
  it("the version follows the content", () => {
    const again = buildSkill(normalizeFiles(files.map((f) => ({ path: f.path, bytes: f.bytes }))));
    assert.equal(again.version, skill.version);
    const changed = buildSkill(normalizeFiles(files.map((f) => ({ path: f.path, bytes: f.path === "REFERENCE.md" ? Buffer.from("# Reference\n\nOther.\n") : f.bytes }))));
    assert.notEqual(changed.version, skill.version);
    assert.equal(skillVersion(files), skill.version);
  });
  it("needs SKILL.md and safe paths", () => {
    assert.throws(() => normalizeFiles([file("a.md", "x")]), /SKILL\.md is required/);
    assert.throws(() => normalizeFiles([file("SKILL.md", "x"), file("../evil.sh", "x")]), /Bad file path/);
    assert.throws(() => normalizeFiles([file("SKILL.md", "x"), file("/etc/passwd", "x")]), /Bad file path/);
    assert.throws(() => normalizeFiles([file("SKILL.md", "x"), file("SKILL.md", "y")]), /twice/);
  });
});

describe("readZip", () => {
  const entries = [["my-skill/SKILL.md", SKILL], ["my-skill/scripts/a.py", "print(1)"], ["my-skill/img/", ""]];
  for (const deflate of [false, true]) {
    it(`reads a ${deflate ? "deflated" : "stored"} zip`, () => {
      const files = normalizeFiles(readZip(zip(entries, { deflate })));
      assert.deepEqual(files.map((f) => f.path), ["SKILL.md", "scripts/a.py"]);
      assert.equal(files[1].bytes.toString(), "print(1)");
    });
  }
  it("rejects a file that is not a zip", () => assert.throws(() => readZip(Buffer.from("nope")), /Not a zip/));
});

describe("addIntent", () => {
  it("keeps one key per request, case and spacing aside", () => {
    let list = addIntent([], "How do I install it?");
    list = addIntent(list, "  how do i   install it? ");
    list = addIntent(list, "set up");
    assert.deepEqual(list, ["How do I install it?", "set up"]);
    assert.deepEqual(addIntent(list, ""), list);
  });
});
