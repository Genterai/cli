import { jsonToMarkdown } from "./markdown.js";
import { inferList } from "./shape.js";
import { splitMarkdown } from "./skills.js";

// A plain read: an item of an area (a file of a repository, a document of a folder, a note, an issue) described from its
// own text, with no model. Reading an area makes one anchor per item, so a model call per item would cost more than the
// read itself; and an item's text says what it is: its name, where it is, its headings. Its sections are its items, each
// embedded on its own, so a question finds the file whose section answers it, not only one whose summary is close.
// Generic: the text is the result's longest text field when it holds most of its text (a file's content, a document's
// body), else the whole result written as Markdown (a note, an issue, an event). No app has a rule of its own.

export const PLAIN = {
  sections: 100, // at most, as an anchor's item lines (genter.js MAX_ITEMS)
  chunkChars: 1500, // a block of text that is not Markdown
  embedChars: 2000, // of a section, with its headings, for its vector
  lineChars: 200, // a section's line, as shown and matched word for word
  summaryText: 700, // of the text, in the summary
};

const MARKDOWN = /\.(md|mdx|markdown)$/i;
const NAME_ARGS = ["path", "file_path", "filepath", "filePath", "file_name", "filename", "fileName", "name", "title", "key"];
const NAME_FIELDS = ["path", "name", "title", "subject", "filename", "file_name", "display_name", "displayName", "summary"];
const flat = (t, n) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

// The text of a result and whether it is one document's text: { text, document }.
export function plainText(data) {
  if (typeof data === "string") return { text: data, document: true };
  let longest = "";
  let total = 0;
  const walk = (value, depth) => {
    if (value == null || depth > 6) return;
    if (typeof value === "string") {
      total += value.length;
      if (value.length > longest.length) longest = value;
      return;
    }
    if (typeof value !== "object") return;
    // A file's content as the API sends it (GitHub): base64 with its encoding beside it.
    if (value.encoding === "base64" && typeof value.content === "string") {
      const decoded = Buffer.from(value.content, "base64").toString("utf8");
      total += decoded.length;
      if (decoded.length > longest.length) longest = decoded;
      for (const [k, v] of Object.entries(value)) if (k !== "content") walk(v, depth + 1);
      return;
    }
    for (const v of Array.isArray(value) ? value : Object.values(value)) walk(v, depth + 1);
  };
  walk(data, 0);
  const single = !(data && typeof data === "object" && !inferList(data).single);
  if (single && longest.trim() && longest.length >= total / 2) return { text: longest, document: true };
  return { text: jsonToMarkdown(data), document: false };
}

// Where the item is, in words: the arg that names it (a path, a name), else the name the result gives it, else the value of
// its first arg.
export function plainName(args = {}, data = null) {
  for (const k of NAME_ARGS) if (typeof args?.[k] === "string" && args[k].trim()) return args[k].trim();
  const own = data && typeof data === "object" && !Array.isArray(data) ? (data.data && typeof data.data === "object" ? data.data : data) : null;
  for (const k of NAME_FIELDS) if (typeof own?.[k] === "string" && own[k].trim()) return own[k].trim();
  const first = Object.values(args ?? {}).find((v) => typeof v === "string" || typeof v === "number");
  return first == null ? "item" : String(first);
}

// Text that is not Markdown, cut at blank lines (else line ends) into blocks of about PLAIN.chunkChars: [[start, end]].
function blocks(text) {
  const out = [];
  let from = 0;
  while (text.length - from > PLAIN.chunkChars) {
    const window = text.slice(from, from + PLAIN.chunkChars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < PLAIN.chunkChars / 3) cut = window.lastIndexOf("\n");
    if (cut < PLAIN.chunkChars / 3) cut = PLAIN.chunkChars;
    out.push([from, from + cut]);
    from += cut;
    while (text[from] === "\n") from++;
  }
  out.push([from, text.length]);
  return out;
}

// The sections of a text: [{ headings, text }], at most PLAIN.sections. Markdown by its headings; anything else in blocks.
export function plainSections(name, text, { markdown } = {}) {
  // A file's extension decides (a "# comment" of a script is no heading); a name with none (a document, a page) goes by its text.
  const named = /\.[a-z0-9]{1,8}$/i.test(String(name).split("/").pop());
  const md = markdown ?? (MARKDOWN.test(name) || (!named && /^#{1,3}[ \t]+\S/m.test(text)));
  const pieces = md
    ? splitMarkdown(name, text).map((p) => ({ headings: p.headings[0] === "Introduction" && p.headings.length === 1 ? [] : p.headings, text: text.slice(p.start, p.end) }))
    : blocks(text).map(([a, b]) => ({ headings: [], text: text.slice(a, b) }));
  return pieces.filter((p) => p.text.trim()).slice(0, PLAIN.sections);
}

// What a plain read is, from its text: the anchor's { title, short, summary, items, keywords, partial: false } and
// `embed`, the texts to embed for its items (one per section, in the order of items). No model.
export function plainDescription({ tool, args, data }) {
  const { text, document } = plainText(data);
  const name = plainName(args, data);
  const base = name.split("/").pop() || name;
  const sections = plainSections(name, text, { markdown: document ? undefined : true });
  const markdown = !document || sections.some((s) => s.headings.length);
  const heading = markdown ? /^ {0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text)?.[1]?.replace(/[`*_]/g, "").trim() : null;
  const title = flat(document ? heading || base : base, 100);
  const headings = [...new Set(sections.flatMap((s) => s.headings))].slice(0, 20);
  const body = flat(markdown ? text.replace(/^ {0,3}#{1,6}[ \t].*$/gm, " ") : text, PLAIN.summaryText);
  const app = String(tool ?? "").split("_")[0].toLowerCase();
  const summary = flat(`${document ? "File" : "Item"} "${name}"${app ? ` (${app})` : ""}.${headings.length ? ` Headings: ${headings.join("; ")}.` : ""} ${body}`, 1200);
  const lines = [];
  const embed = [];
  for (const s of sections) {
    const where = s.headings.length ? s.headings.join(" › ") : base;
    const line = flat(`${where}: ${s.headings.length ? s.text.replace(/^ {0,3}#{1,6}[ \t].*$/m, "") : s.text}`, PLAIN.lineChars);
    if (lines.includes(line)) continue;
    lines.push(line);
    embed.push(`${base}${s.headings.length ? ` › ${s.headings.join(" › ")}` : ""}\n${s.text.slice(0, PLAIN.embedChars)}`);
  }
  const keywords = [...new Set([base, ...name.split("/").filter((p) => p && p !== base), ...headings].map((k) => flat(k, 60).toLowerCase()).filter(Boolean))].slice(0, 30);
  return {
    title,
    short: flat(body || title, 140),
    summary,
    items: lines,
    keywords,
    partial: false,
    embed,
  };
}
