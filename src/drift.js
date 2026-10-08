// Anchor Drift: facts about how fresh an anchor's source is, shown next to a result. Genter states facts only (dates, a
// "replaced" mark the source carries itself) and never says whether the source is right: comparing sources by meaning
// is the client's agent's job. No model is called here, no connector is named: fields are found by their names.

export const STALE_DAYS = 365; // an anchor's source older than this is "old" ...
export const SIBLING_RECENT_DAYS = 30; // ... when another source in the same answer changed within this
export const AREA_RECENT_DAYS = 90; // ... or when most of its area changed within this
export const AREA_MIN_ITEMS = 5; // an area smaller than this says nothing
export const AREA_MIN_SHARE = 0.5; // share of the area's items changed within AREA_RECENT_DAYS
export const HEAD_LINES = 4; // a replaced-mark counts only in the first lines of a document ...
export const HEAD_LINE_MAX = 200; // ... and in a short line (a notice or a heading, not a paragraph)
const DAY = 86_400_000;

const norm = (k) => String(k).toLowerCase().replace(/[^a-z]/g, "");
const MODIFIED = new Set(["modifiedtime", "modifiedat", "modified", "updatedat", "updatedtime", "updated", "lastedited", "lasteditedtime", "lastmodified", "lastmodifiedtime", "lastupdated", "datemodified", "pushedat", "mtime"]);
const CREATED = new Set(["createdtime", "createdat", "created", "datecreated", "creationtime", "createdon"]);
const PERSON = new Set(["committer", "author", "commit"]); // {commit: {committer: {date}}}: the date of a person's act

// An ISO-like string (or an HTTP date) as ms, or null; nothing before 1990 or later than tomorrow.
export function toMs(v, now = Date.now()) {
  if (typeof v !== "string" || v.length < 8 || v.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) && !/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= Date.parse("1990-01-01") && t <= now + DAY ? t : null;
}

// { source_at, source_created_at } (ISO) found in a result by field names: the freshest modified date, and the freshest
// creation date. A list takes the freshest of its items. `headers`: { last_modified } of a site, folded in as a modified date.
export function sourceDates(data, { lastModified, now = Date.now() } = {}) {
  let modified = toMs(lastModified, now) ?? 0;
  let created = 0;
  let seen = 0;
  const walk = (v, depth, inPerson) => {
    if (seen++ > 3000 || depth > 5 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.slice(0, 200).forEach((x) => {
      walk(x, depth + 1, inPerson);
    });
    for (const [k, x] of Object.entries(v)) {
      const key = norm(k);
      if (typeof x === "string") {
        const t = toMs(x, now);
        if (!t) continue;
        if (MODIFIED.has(key) || (inPerson && key === "date")) modified = Math.max(modified, t);
        else if (CREATED.has(key)) created = Math.max(created, t);
      } else if (x && typeof x === "object") walk(x, depth + 1, inPerson || PERSON.has(key));
    }
  };
  walk(data, 0, false);
  return { ...(modified && { source_at: new Date(modified).toISOString() }), ...(created && { source_created_at: new Date(created).toISOString() }) };
}

// The marks of "this is replaced", as a document puts them at its top. Each needs a notice form, so a word inside a
// sentence about something else ("deprecated API handling", `deprecated_fn()`) is not one.
const MARKS = [
  ["deprecated", /(?:\b(?:is|was|has been|are|now)\s+(?:now\s+)?|^[\s>#*_\-\[(]*|[\[(*]\s*)deprecated\b(?![\w(`-])/i],
  ["obsolete", /(?:\b(?:is|was|has been|are|now)\s+(?:now\s+)?|^[\s>#*_\-\[(]*|[\[(*]\s*)obsolete\b(?![\w(`-])/i],
  ["superseded", /\b(?:is|was|has been|are|now)\s+superseded\b|^[\s>#*_\-\[(]*superseded\b|\bsuperseded by\b/i],
  ["replaced by", /\b(?:is|was|has been|are|now)\s+(?:now\s+)?replaced by\b|\breplaced by\b\s*(?:\[|<|https?:)/i],
  ["moved to", /\b(?:has|have)?\s*moved to\b(?=[^\n]{0,80}(?:https?:\/\/|\]\())/i],
  ["no longer maintained", /\bno longer (?:maintained|supported|updated)\b/i],
  ["archived", /\b(?:is|was|has been)\s+archived\b|^[\s>#*_\-\[(]*archived\b\s*[:\]\-–—!)]/i],
  ["устарел", /(?:^|[\s>#*_\[(])(?:устарел\w*|устаревш\w+)(?![\wа-я-])/iu],
  ["заменён", /(?:^|[\s>#*_\[(])(?:заменён\w*|заменен\w*|заменено|заменена)(?![\wа-я-])/iu],
  ["перенесён", /(?:^|[\s>#*_\[(])(?:перенесён\w*|перенесен\w*)(?![\wа-я-])/iu],
];
const TEXT_KEYS = ["title", "name", "subject", "heading", "text", "content", "body", "markdown", "description", "plain_text"];
const BOOL_MARKS = [["archived", /^(is_?)?archived$/i], ["deprecated", /^(is_?)?deprecated$/i], ["obsolete", /^(is_?)?obsolete$/i]];
const URL_RE = /https?:\/\/[^\s)>\]"'<]+/;

// { marker, by? } when the result is ONE document that marks itself as replaced at its top (its title or its first
// lines), or carries a flag (archived: true); null otherwise. A list never is: one item's mark is not the list's.
export function supersededOf(data) {
  let doc = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (!TEXT_KEYS.some((k) => typeof doc[k] === "string")) {
    const inner = Object.values(doc).find((v) => v && typeof v === "object" && !Array.isArray(v) && TEXT_KEYS.some((k) => typeof v[k] === "string"));
    if (inner) doc = inner;
  }
  for (const [marker, re] of BOOL_MARKS) {
    const flagged = Object.entries(doc).find(([k, v]) => v === true && re.test(k));
    if (flagged) return { marker };
  }
  const lines = [];
  for (const k of TEXT_KEYS) {
    if (typeof doc[k] !== "string") continue;
    const own = k === "title" || k === "name" || k === "subject" || k === "heading";
    const take = doc[k].slice(0, 1500).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, own ? 1 : HEAD_LINES);
    take.forEach((l, i) => {
      lines.push([l, doc[k].slice(0, 1500).split("\n").map((x) => x.trim()).filter(Boolean)[i + 1]]);
    });
  }
  for (const [line, next] of lines) {
    if (line.length > HEAD_LINE_MAX) continue;
    for (const [marker, re] of MARKS) {
      const m = re.exec(line);
      if (!m) continue;
      const rest = line.slice(m.index);
      const by = URL_RE.exec(rest)?.[0] ?? (next && next.length <= HEAD_LINE_MAX ? URL_RE.exec(next)?.[0] : undefined);
      return { marker, ...(by && { by: by.replace(/[.,;:!?]+$/, "") }) };
    }
  }
  return null;
}

// A site's address as a page identity, so http/https, www, a trailing slash or #fragment is no move.
const pageKey = (u) => String(u).replace(/#.*$/, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
// A requested URL that ended up on another page after redirects is that page's replacement.
export const redirectOf = (requested, final) => (requested && final && pageKey(requested) !== pageKey(final) ? { marker: "redirect", by: final } : null);

// What an execution learned about its source: { source_at?, source_created_at?, superseded? }.
// extra: { last_modified?, redirect? } from a call made here (web.js) that saw HTTP headers.
export function signalsOf(data, extra = {}) {
  const dates = sourceDates(data, { lastModified: extra.last_modified });
  const superseded = extra.redirect ?? supersededOf(data);
  return { ...dates, ...(superseded && { superseded }) };
}

// Simple statistics of an area from the version dates of its listed items: { items, recent, median, days, at }.
// null with no dates at all (the list has no modified date: nothing to say).
export function areaStats(versions, { now = Date.now(), days = AREA_RECENT_DAYS } = {}) {
  const times = [...versions].map((v) => toMs(String(v), now)).filter(Boolean).sort((a, b) => a - b);
  if (!times.length) return null;
  const median = times[Math.floor(times.length / 2)];
  return { items: times.length, recent: times.filter((t) => t >= now - days * DAY).length, median: new Date(median).toISOString(), days, at: new Date(now).toISOString() };
}

const month = (iso) => String(iso).slice(0, 7);
const at = (s) => s?.source_at ?? s?.updated_at ?? null;

// The facts shown next to one result, from its signals and the signals of the other results of the same answer:
// [] when nothing deviates (then nothing is added: a note on every line would be ignored). No verdict, only facts.
export function driftFacts(signals, others = [], { now = Date.now() } = {}) {
  if (!signals) return [];
  const facts = [];
  const mine = at(signals);
  const t = mine && Date.parse(mine);
  if (signals.superseded) {
    const { marker, by } = signals.superseded;
    facts.push(marker === "redirect" ? `address now redirects to ${by}` : by ? `marked as replaced: ${by}` : `marked as ${marker} in its own text`);
  }
  if (t && now - t > STALE_DAYS * DAY) {
    const label = `${signals.source_at ? "source" : "anchor content"} last changed ${month(mine)}`;
    const recent = others.filter((o) => o !== signals).map(at).map((d) => d && Date.parse(d)).filter((x) => x && now - x <= SIBLING_RECENT_DAYS * DAY);
    const a = signals.area_stats;
    const clauses = [];
    if (recent.length) clauses.push(`${recent.length > 1 ? "other sources" : "another source"} in this answer changed within the last ${SIBLING_RECENT_DAYS} days`);
    if (a && a.items >= AREA_MIN_ITEMS && a.recent / a.items >= AREA_MIN_SHARE) clauses.push(`${a.recent} of ${a.items} items in this area changed in the last ${a.days} days`);
    if (clauses.length) facts.unshift([label, ...clauses].join("; "));
  }
  return facts;
}

// Results of one answer, each with { signals }: how many different sources they come from (toolkit/account/area).
export const sourceCount = (results) => new Set(results.map((r) => r.signals?.source).filter(Boolean)).size;
export const sourcesLine = (n) => `These results come from ${n} different sources. Compare them before answering and tell the user if they disagree.`;
