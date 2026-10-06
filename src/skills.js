import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

// Skills: a folder (SKILL.md, other markdown, artifacts, scripts) that Genter turns into search-able pieces.
// This file is the pure part: no I/O, no models, no execution. A skill NEVER becomes one Anchor: each Anchor is one call
// that reads ONE piece ("read section X of skill Y at version Z", SKILL_READ_CHUNK) or hands over ONE file
// (SKILL_GET_FILE), with fixed args, exactly like any other call (see specs/skills.md).

export const SKILL_TOOLS = { chunk: "SKILL_READ_CHUNK", file: "SKILL_GET_FILE" };
export const isSkillTool = (tool) => tool === SKILL_TOOLS.chunk || tool === SKILL_TOOLS.file;

export const LIMITS = {
  files: 500,
  fileBytes: 5 * 1024 * 1024, // one file
  totalBytes: 25 * 1024 * 1024, // the whole skill
  chunkChars: 6000, // a section longer than this is cut at paragraph borders
  inlineBytes: 64 * 1024, // a text file up to this size is returned in the result; larger or binary ones as a link
  splitDepth: 3, // headings # to ### start a new piece, deeper ones stay inside their parent
};

const sha = (data) => createHash("sha256").update(data).digest("hex");

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const SCRIPT = /\.(sh|bash|zsh|fish|py|rb|pl|php|js|mjs|cjs|ts|ps1|psm1|bat|cmd|lua|r|go|rs|java|kt|swift|c|cc|cpp|cs|sql|awk)$/i;
const TEXT = /\.(txt|json|ya?ml|toml|ini|csv|tsv|xml|html?|css|svg|tex|rst|env\.example|conf|cfg|log|j2|jinja2?|hbs|mustache|liquid|tmpl|template|graphql|proto|lock)$/i;
const MIME = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json", yaml: "application/yaml", yml: "application/yaml",
  csv: "text/csv", xml: "application/xml", html: "text/html", htm: "text/html", css: "text/css", svg: "image/svg+xml", js: "text/javascript",
  mjs: "text/javascript", py: "text/x-python", sh: "text/x-shellscript", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", ico: "image/x-icon",
  zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const mimeOf = (path) => MIME[String(path).split(".").pop().toLowerCase()] ?? "application/octet-stream";

// markdown: text that is read as pieces; script: code, handed over as code and NEVER run here; artifact: anything else
// (templates, static files, images, fonts).
export function fileKind(path, bytes) {
  if (MARKDOWN.test(path)) return "markdown";
  if (SCRIPT.test(path)) return "script";
  if (bytes && !TEXT.test(path) && /^#!\s*\//.test(Buffer.from(bytes.subarray(0, 64)).toString("latin1"))) return "script"; // a shebang
  return "artifact";
}

// ---- Files in: validation, zip ----

// A path inside the skill: relative, forward slashes, no "..", no empty parts.
export function cleanPath(path) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || p.includes("\0") || /^[a-zA-Z]:/.test(p)) throw new Error(`Bad file path: ${JSON.stringify(path)}`);
  const parts = p.split("/").filter((x) => x && x !== ".");
  if (!parts.length) throw new Error(`Bad file path: ${JSON.stringify(path)}`);
  return parts.join("/");
}

const JUNK = /(^|\/)(__MACOSX|\.git|\.DS_Store|Thumbs\.db|node_modules)(\/|$)/;

// [{ path, bytes: Buffer }] -> checked files [{ path, bytes, size, sha, kind, mime }]. A single top folder shared by every
// file is dropped (a zip of "my-skill/..."). SKILL.md must be at the root.
export function normalizeFiles(input) {
  if (!Array.isArray(input) || !input.length) throw new Error("A skill needs files");
  let files = input.map((f) => ({ path: cleanPath(f.path), bytes: Buffer.from(f.bytes) })).filter((f) => !JUNK.test(f.path));
  if (!files.length) throw new Error("A skill needs files");
  const roots = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : null)));
  if (roots.size === 1 && !roots.has(null)) files = files.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
  if (files.length > LIMITS.files) throw new Error(`A skill has at most ${LIMITS.files} files`);
  const seen = new Set();
  let total = 0;
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`The file ${f.path} is twice in the skill`);
    seen.add(f.path);
    if (f.bytes.length > LIMITS.fileBytes) throw new Error(`${f.path} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB`);
    total += f.bytes.length;
  }
  if (total > LIMITS.totalBytes) throw new Error(`A skill is at most ${LIMITS.totalBytes / 1024 / 1024} MB`);
  if (!files.some((f) => f.path === "SKILL.md")) throw new Error("SKILL.md is required at the root of the skill");
  return files
    .map((f) => ({ ...f, size: f.bytes.length, sha: sha(f.bytes), kind: fileKind(f.path, f.bytes), mime: mimeOf(f.path) }))
    .sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1));
}

// A zip archive (Buffer) -> [{ path, bytes }]. Stored and deflated entries only; paths are checked by normalizeFiles.
// Inflating is capped at the file limit, so a zip bomb stops early.
export function readZip(buffer) {
  const buf = Buffer.from(buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count > LIMITS.files * 4) throw new Error("The zip has too many entries");
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("The zip is damaged");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("An encrypted zip cannot be read");
    if (size > LIMITS.fileBytes) throw new Error(`${name} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("The zip is damaged");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ path: name, bytes: Buffer.from(raw) });
    else if (method === 8) out.push({ path: name, bytes: inflateRawSync(raw, { maxOutputLength: LIMITS.fileBytes }) });
    else throw new Error(`${name}: zip compression ${method} is not supported`);
  }
  return out;
}

// ---- SKILL.md front matter ----

// { name, description, body } of a SKILL.md: the YAML front matter between --- lines (name, description; quoted, plain
// and folded > / | values), the rest is the body.
export function parseSkillMd(text) {
  const src = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(src);
  if (!m) return { name: null, description: null, body: src, bodyStart: 0 };
  const meta = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === "")) folded.push(lines[++i].trim());
      value = folded.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (/^(['"])[\s\S]*\1$/.test(value)) value = value.slice(1, -1);
    meta[kv[1].toLowerCase()] = value;
  }
  return { name: meta.name || null, description: meta.description || null, body: src.slice(m[0].length), bodyStart: m[0].length };
}

// ---- Markdown -> pieces ----

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";

// Cuts one markdown file into pieces by its headings (levels 1-3), deterministically and without any model. A heading
// inside a fenced code block is not a heading. Text before the first heading is the "intro" piece. A section longer
// than LIMITS.chunkChars is cut at blank lines into parts. A heading with no text of its own gives no piece (its
// children carry it in their path). Pieces keep offsets into the file, so the text is never stored twice.
// Returns [{ id, path, title, headings, level, start, end, part? }].
export function splitMarkdown(path, text, { from = 0 } = {}) {
  const src = String(text);
  const sections = [];
  let current = { headings: [], level: 0, start: from };
  const stack = [];
  let fence = null;
  let offset = 0;
  for (const line of src.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (lineStart < from) continue;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!h || h[1].length > LIMITS.splitDepth) continue;
    sections.push({ ...current, end: lineStart });
    const level = h[1].length;
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    stack.push({ level, title: h[2].replace(/[`*_]/g, "").trim() });
    current = { headings: stack.map((s) => s.title), level, start: lineStart };
  }
  sections.push({ ...current, end: src.length });

  const used = new Map();
  const unique = (base) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  };
  const out = [];
  for (const s of sections) {
    const body = src.slice(s.start, s.end);
    // Only the heading line (or only blanks): nothing to read here.
    const own = s.level ? body.replace(/^[^\n]*\n?/, "") : body;
    if (!own.trim()) continue;
    const headings = s.headings.length ? s.headings : [];
    const title = headings.at(-1) ?? "Introduction";
    const base = unique(`${path}#${s.headings.length ? headings.map(slug).join("/") : "intro"}`);
    const parts = body.length > LIMITS.chunkChars ? cutParts(src, s.start, s.end) : [[s.start, s.end]];
    parts.forEach(([start, end], i) => {
      out.push({ id: parts.length > 1 ? `${base}.p${i + 1}` : base, path, title: parts.length > 1 ? `${title} (part ${i + 1})` : title, headings: headings.length ? headings : ["Introduction"], level: s.level, start, end });
    });
  }
  return out;
}

// Cuts [start, end) at blank lines into parts of about LIMITS.chunkChars; a single paragraph longer than that is cut at a line break.
function cutParts(src, start, end) {
  const parts = [];
  let from = start;
  while (end - from > LIMITS.chunkChars) {
    const window = src.slice(from, from + LIMITS.chunkChars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < LIMITS.chunkChars / 3) cut = window.lastIndexOf("\n");
    if (cut < LIMITS.chunkChars / 3) cut = LIMITS.chunkChars;
    parts.push([from, from + cut]);
    from += cut;
    while (src[from] === "\n") from++;
  }
  parts.push([from, end]);
  return parts;
}

// Files a piece of text points to: markdown links [x](path), images ![x](path), and `path` in backticks, resolved from
// the file's own folder and kept only when they are files of the skill. Fragment (#anchor) and query are cut.
export function referencedFiles(text, fromPath, known) {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const set = new Set();
  const take = (raw) => {
    let target = String(raw).trim().replace(/^<|>$/g, "").split("#")[0].split("?")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep as written */
    }
    const resolve = (base) => {
      const resolved = [];
      for (const p of `${base}${target}`.split("/")) {
        if (!p || p === ".") continue;
        if (p === "..") resolved.pop();
        else resolved.push(p);
      }
      return resolved.join("/");
    };
    // From the file's own folder first, then from the root of the skill (SKILL.md usually names files that way).
    const full = [target.startsWith("/") ? resolve("") : resolve(dir ? `${dir}/` : ""), resolve("")].find((p) => known.has(p));
    if (full && full !== fromPath) set.add(full);
  };
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) take(m[1]);
  for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) if (/[./]/.test(m[1]) && !/\s/.test(m[1])) take(m[1]);
  return [...set].sort();
}

// ---- A whole skill ----

// The version of a skill: a hash of its files (paths and contents). Changing, adding or removing any file changes it.
export const skillVersion = (files) =>
  sha(files.map((f) => `${f.path}\0${f.sha}`).sort().join("\n")).slice(0, 16);

// What the pieces of a skill are, from its (normalized) files: no I/O, no model.
// { name, description, version, files: [{ path, kind, mime, size, sha }], chunks: [{ id, path, title, headings, level, start,
//   end, refs: [artifact/script paths], see: [chunk ids of other markdown files] }], texts: Map(path -> text),
//   recipes: { chunks, files } } (anchors: what "Generate project" would make).
export function buildSkill(files, { fallbackName = "skill" } = {}) {
  const texts = new Map(files.filter((f) => f.kind === "markdown").map((f) => [f.path, f.bytes.toString("utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n")]));
  const meta = parseSkillMd(texts.get("SKILL.md") ?? "");
  const known = new Set(files.map((f) => f.path));
  const chunks = [];
  for (const f of files) {
    if (f.kind !== "markdown") continue;
    const text = texts.get(f.path);
    const from = f.path === "SKILL.md" ? meta.bodyStart : 0;
    for (const c of splitMarkdown(f.path, text, { from })) chunks.push(c);
  }
  const firstOf = new Map();
  for (const c of chunks) if (!firstOf.has(c.path)) firstOf.set(c.path, c.id);
  const kindOf = new Map(files.map((f) => [f.path, f.kind]));
  for (const c of chunks) {
    const refs = referencedFiles(texts.get(c.path).slice(c.start, c.end), c.path, known);
    c.refs = refs.filter((p) => kindOf.get(p) !== "markdown");
    c.see = refs.filter((p) => kindOf.get(p) === "markdown" && firstOf.has(p)).map((p) => firstOf.get(p));
  }
  const heading = /^\s*#\s+(.+)$/m.exec(meta.body)?.[1]?.trim();
  const name = meta.name || heading || fallbackName;
  const description = meta.description || firstParagraph(meta.body) || name;
  const nonText = files.filter((f) => f.kind !== "markdown");
  return {
    name: String(name).slice(0, 120),
    description: String(description).slice(0, 1000),
    version: skillVersion(files),
    files: files.map(({ path, kind, mime, size, sha: h }) => ({ path, kind, mime, size, sha: h })),
    chunks,
    texts,
    recipes: { chunks: chunks.length, files: nonText.length, total: chunks.length + nonText.length },
  };
}

function firstParagraph(body) {
  for (const p of String(body).split(/\n{2,}/)) {
    const t = p.replace(/^#+\s.*$/gm, "").trim();
    if (t) return t.replace(/\s+/g, " ").slice(0, 400);
  }
  return null;
}

// The text embedded for the skill as a whole (choosing a skill): what it is and which sections it has.
export function skillEmbeddingText(skill) {
  const titles = [...new Set(skill.chunks.map((c) => c.headings.join(" › ")))].slice(0, 40).join("; ");
  return `${skill.name}. ${skill.description}${titles ? `\nSections: ${titles}` : ""}`.slice(0, 6000);
}

// The text embedded for one piece (choosing a fragment): where it is, then its start.
export function chunkEmbeddingText(skill, chunk, text) {
  return `${skill.name} › ${chunk.headings.join(" › ")}\n${text.slice(chunk.start, chunk.end).slice(0, 1800)}`;
}

// The Anchor call that reads a piece / hands over a file at a version. Fixed args, nothing to fill in.
export const chunkCall = (skillId, version, chunkId) => ({ tool: SKILL_TOOLS.chunk, args: { skill: skillId, version, chunk: chunkId } });
export const fileCall = (skillId, version, path) => ({ tool: SKILL_TOOLS.file, args: { skill: skillId, version, path } });

// The label a script carries wherever it is offered: Genter only hands code over.
export const SCRIPT_NOTE = "Executable code. Genter does NOT run it: read it, or run it yourself where you may.";

// Intent keys of an anchor: the requests it answered, as text, no duplicates (case and spacing aside), newest last, at most MAX.
export const MAX_INTENTS = 12;
export function addIntent(list = [], task) {
  const text = String(task ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return list;
  const key = text.toLowerCase();
  if (list.some((t) => t.toLowerCase() === key)) return list;
  const next = [...list, text];
  return next.length > MAX_INTENTS ? next.slice(next.length - MAX_INTENTS) : next;
}
