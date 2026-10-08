// A tool result (JSON) as readable Markdown: the main list as items with a title and their fields,
// other fields as a short list. Long texts are cut, big nested blobs (payloads, raw parts) are left out.

const TITLE = ["subject", "title", "name", "full_name", "summary", "displayName", "display_name", "label", "email", "login", "filename", "key", "text"];
const NOISE = /^(payload|parts|raw|headers|html|body_html|htmlBody|attachmentList|_links|node_id|etag|kind|threadId|historyId|sizeEstimate|next_?page_?token|page_?token|cursor|.*_url_template)$/i;
const LINK = ["display_url", "html_url", "web_url", "webViewLink", "webLink", "permalink", "htmlLink", "url", "link"];
const MAX_ITEMS = 50;
const MAX_TEXT = 400;

export function jsonToMarkdown(data) {
  const value = unwrap(data);
  if (value == null || value === "") return "_Nothing returned._";
  if (typeof value !== "object") return scalar(value, MAX_TEXT * 5);
  if (Array.isArray(value)) return list(value);

  const out = [];
  const fields = [];
  for (const [k, v] of Object.entries(value)) {
    if (NOISE.test(k) || v == null || v === "") continue;
    if (Array.isArray(v) && v.some(isObject)) out.push(`### ${label(k)}\n\n${list(v)}`);
    else if (isObject(v) && Object.keys(v).length > 3) out.push(`### ${label(k)}\n\n${fieldList(v, 1)}`);
    else fields.push(field(k, v));
  }
  return [fields.filter(Boolean).join("\n"), ...out].filter(Boolean).join("\n\n") || "_Nothing returned._";
}

// { data: { messages: [...] } } -> [...]: skip wrappers with a single meaningful key.
function unwrap(value) {
  for (let i = 0; i < 4 && isObject(value); i++) {
    const keys = Object.keys(value).filter((k) => value[k] != null && value[k] !== "" && !NOISE.test(k));
    if (keys.length !== 1 || typeof value[keys[0]] !== "object") break;
    value = value[keys[0]];
  }
  return value;
}

function list(items) {
  if (!items.length) return "_Empty list._";
  const shown = items.slice(0, MAX_ITEMS);
  const body = shown.every(isObject)
    ? shown.map(item).join("\n\n")
    : shown.map((v) => `- ${isObject(v) || Array.isArray(v) ? inlineJson(v) : scalar(v)}`).join("\n");
  const more = items.length > MAX_ITEMS ? `\n\n_…and ${items.length - MAX_ITEMS} more._` : "";
  return `${body}${more}`;
}

// One object of a list: its title as a heading, a long text as a paragraph, the rest as fields.
function item(obj) {
  const titleKey = TITLE.find((k) => typeof obj[k] === "string" && obj[k].trim()) ?? findHeader(obj, "subject");
  const title = titleKey ? (titleKey.value ?? obj[titleKey]) : obj.id != null ? `#${obj.id}` : "Item";
  const textKey = Object.keys(obj).find((k) => k !== titleKey && typeof obj[k] === "string" && obj[k].length > 120 && !/url|link|id$/i.test(k));
  // The item's own page, if it has one, becomes the title link.
  const linkKey = LINK.find((k) => typeof obj[k] === "string" && /^https?:\/\//.test(obj[k]));
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== titleKey && k !== textKey && k !== linkKey));
  const name = escapeMarkdown(oneLine(title).replace(/[[\]]/g, "").slice(0, 200));
  const parts = [`#### ${linkKey ? `[${name}](${obj[linkKey].replace(/[()\s]/g, encodeURIComponent)})` : name}`];
  const fields = fieldList(rest, 1);
  if (fields) parts.push(fields);
  if (textKey) parts.push(quote(obj[textKey]));
  return parts.join("\n\n");
}

// Gmail keeps the subject in payload.headers.
function findHeader(obj, name) {
  const header = obj.payload?.headers?.find?.((h) => h.name?.toLowerCase() === name);
  return header?.value ? { value: header.value } : null;
}

function fieldList(obj, depth) {
  return Object.entries(obj)
    .filter(([k, v]) => !NOISE.test(k) && v != null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => {
      if (isObject(v) && depth > 0) {
        const nested = Object.entries(v).filter(([nk, nv]) => !NOISE.test(nk) && nv != null && nv !== "" && typeof nv !== "object");
        return nested.length ? `- **${label(k)}:** ${nested.slice(0, 6).map(([nk, nv]) => `${label(nk)} ${scalar(nv, 120)}`).join(" · ")}` : null;
      }
      return field(k, v);
    })
    .filter(Boolean)
    .join("\n");
}

function field(k, v) {
  if (Array.isArray(v)) {
    const flat = v.filter((x) => x != null && typeof x !== "object");
    if (flat.length === v.length) return `- **${label(k)}:** ${flat.slice(0, 20).map((x) => scalar(x, 120)).join(", ")}${v.length > 20 ? ", …" : ""}`;
    return `- **${label(k)}:** ${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (isObject(v)) return `- **${label(k)}:** ${inlineJson(v)}`;
  return `- **${label(k)}:** ${scalar(v)}`;
}

function scalar(v, max = MAX_TEXT) {
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = oneLine(String(v));
  if (/^https?:\/\/\S+$/.test(s)) return s;
  return escapeMarkdown(s.length > max ? `${s.slice(0, max)}…` : s);
}

function quote(text) {
  const s = String(text).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cut = s.length > MAX_TEXT * 2 ? `${s.slice(0, MAX_TEXT * 2)}…` : s;
  return cut
    .split("\n")
    .map((line) => `> ${escapeMarkdown(line)}`)
    .join("\n");
}

function inlineJson(v) {
  const s = JSON.stringify(v);
  return `\`${s.length > 160 ? `${s.slice(0, 160)}…` : s}\``;
}

// messageTimestamp -> Message timestamp, label_ids -> Label ids.
function label(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
// Keep values literal: no accidental emphasis, code or headings from the data.
// URLs stay as they are, so they still become links.
const escapeMarkdown = (s) =>
  s
    .split(/(https?:\/\/\S+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/([\\`*_\[\]])/g, "\\$1")))
    .join("")
    .replace(/^([#>]|\d+[.)]\s|[-+]\s)/, "\\$1");
const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
