import { idKeys, inferList, locatorArgs, pick } from "./sync.js";

// References: where the facts of an answer come from, and how to write back there.
// A reference is { n, app, kind, title, url?, path?, where, via, source?, tool?, score? }:
//   app    the toolkit: github, gmail, linear...
//   kind   what it is: file, folder, issue, pull_request, repository, page, email, event, task, or for any other app the
//          noun of the call that listed it (record, card, message...)
//   where  the args that point to it, named the way the app's write tools name them: {owner, repo, path, branch},
//          {thread_id}, {tasklist_id, task_id}; for other apps the list call's own args plus the item's id fields
//   via    how the run found it: knowledge (a synced source), item (one item of a list result), call (a call's whole
//          result), recipe (a saved result), link (a link the user gave)
// The agent numbers references as it shows them to the model, the answer cites them as [n], and writeHints says which
// write tools work at a reference, with their args already filled from `where`: known ones for popular apps, and for
// any other app its own tools, ranked by how much of `where` they take.

// The toolkit of a tool slug: the longest connected app that prefixes it, else its first word.
export function appOf(tool, apps = []) {
  const slug = String(tool ?? "").toUpperCase();
  const known = [...apps].filter((a) => slug.startsWith(`${String(a).toUpperCase().replace(/-/g, "_")}_`)).sort((a, b) => b.length - a.length)[0];
  return known ?? slug.split("_")[0].toLowerCase();
}

// ---------- What a reference is, per app ----------

// A reference from what a run saw: { app, via, title?, url?, item?, part?, tool?, where?, raw?, text? } -> a reference.
// raw (an item of a call result) and text (a knowledge chunk) are only read here, never kept.
export function shapeRef(r) {
  const url = link(r.url);
  const where = clean(r.where ?? {});
  const known = SHAPES[r.app]?.({ ...r, url, where });
  const nouns = [...nounsOf(r.tool, r.app), ...(r.part ? [stem(r.part)] : [])];
  const out = known ?? { kind: r.kind ?? nouns.at(-1) ?? "item", title: r.title ?? r.item ?? null, where };
  return clean({
    app: r.app,
    kind: out.kind,
    title: String(out.title ?? r.title ?? out.kind).slice(0, 200),
    url,
    path: out.path,
    where: clean(out.where),
    via: r.via,
    source: r.source,
    tool: r.tool,
    score: r.score,
  });
}

const GITHUB_URL = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)(?:\/(blob|tree|issues|pull|commit)\/([^?#]+))?\/?(?:[?#].*)?$/;

const SHAPES = {
  github({ url, where: w, item, part, tool = "", title }) {
    const m = url?.match(GITHUB_URL);
    let owner = w.owner ?? m?.[1];
    let repo = w.repo ?? m?.[2];
    // A repository listed by its full name ("Genterai/genter-cli").
    if (!owner && /^[\w.-]+\/[\w.-]+$/.test(String(item ?? ""))) [owner, repo] = String(item).split("/");
    if (!owner || !repo) return null;
    const at = { owner, repo };
    const [segment, rest = ""] = [m?.[3], m?.[4]];
    const branch = w.branch ?? w.ref ?? w.tree_sha ?? (segment === "blob" || segment === "tree" ? rest.split("/")[0] : undefined);
    if (part === "about") return { kind: "repository", title: `${owner}/${repo}`, where: at };
    // A file: an item of the files list (its id is its path), a file read live, or a link to it.
    if (part === "files" || /_GET_A_TREE$/.test(tool) || /_GET_(RAW_)?REPOSITORY_CONTENT$/.test(tool) || segment === "blob") {
      const path = part === "files" || /_GET_A_TREE$/.test(tool) ? String(item ?? w.path) : (w.path ?? rest.split("/").slice(1).join("/"));
      if (!path || path === "undefined") return null;
      return { kind: "file", title: path, path, where: { ...at, path, branch } };
    }
    if (segment === "tree") {
      const path = rest.split("/").slice(1).join("/");
      return { kind: "folder", title: path || `${owner}/${repo}`, path, where: { ...at, path, branch } };
    }
    const number = Number(w.issue_number ?? w.pull_number ?? w.number ?? (segment === "issues" || segment === "pull" ? rest.split("/")[0] : part === "issues" ? item : NaN));
    if (Number.isInteger(number) && (part === "issues" || segment === "issues" || segment === "pull" || /_(ISSUE|PULL)/.test(tool))) {
      const pull = segment === "pull" || w.pull_number != null || (/PULL/.test(tool) && segment !== "issues");
      return { kind: pull ? "pull_request" : "issue", title: title ?? `#${number}`, where: { ...at, issue_number: number, ...(pull && { pull_number: number }) } };
    }
    if (segment === "commit" || (w.sha && /COMMIT/.test(tool))) {
      const sha = segment === "commit" ? rest.split("/")[0] : w.sha;
      return { kind: "commit", title: title ?? sha.slice(0, 7), where: { ...at, commit_sha: sha } };
    }
    if (!segment) return { kind: "repository", title: `${owner}/${repo}`, where: at };
    return null;
  },

  gmail({ where: w, item, tool = "", via, title, raw, text }) {
    if (/LABEL|DRAFT|PROFILE|CONTACT|PEOPLE/.test(tool)) return null;
    const message_id = w.message_id ?? w.messageId ?? (via === "knowledge" ? item : /MESSAGE|EMAIL/.test(tool) ? w.id : undefined);
    const thread_id = w.thread_id ?? w.threadId ?? (/THREAD/.test(tool) ? w.id : undefined);
    if (!message_id && !thread_id) return null;
    // Who to answer: the sender of the email (from the item itself, or the "sender:" line of a synced one).
    const from = emailOf(raw?.sender ?? raw?.from ?? String(text ?? "").match(/^sender: (.+)$/m)?.[1]);
    return { kind: "email", title: title ?? raw?.subject, where: { message_id, thread_id, from } };
  },

  googlecalendar({ where: w, item, tool = "", title }) {
    if (/CALENDARS|CALENDAR_LIST|COLORS|SETTINGS|FREE_?BUSY/.test(tool)) return null;
    const event_id = w.event_id ?? w.eventId ?? w.id ?? item;
    if (!event_id) return null;
    return { kind: "event", title, where: { calendar_id: w.calendar_id ?? w.calendarId ?? "primary", event_id } };
  },

  googletasks({ where: w, item, tool = "", title }) {
    if (/TASK_?LISTS/.test(tool)) return null;
    const [list, own] = String(item ?? "").includes("/") ? String(item).split("/") : [undefined, item];
    const task_id = w.task_id ?? w.id ?? own;
    if (!task_id) return null;
    return { kind: "task", title, where: { tasklist_id: w.tasklist_id ?? w.tasklist ?? list ?? "@default", task_id } };
  },

  notion({ url, where: w, item, tool = "", title, raw }) {
    // Pages and database rows (rows are pages); not databases, users or comments.
    if ((raw?.object && raw.object !== "page") || (/USERS?$|COMMENTS?$|LIST_DATABASES|FETCH_DATABASE$/.test(tool) && !w.page_id)) return null;
    const id = w.page_id ?? w.id ?? item ?? notionId(url);
    if (!id || !/^[0-9a-f-]{32,36}$/i.test(String(id))) return null;
    return { kind: "page", title, where: { page_id: dashed(String(id)) } };
  },
};

// A link to a place in an app, as a reference: GitHub files, folders, issues, pull requests and repositories,
// Notion pages, Gmail threads, Google Calendar events. null for links it does not know.
export function refFromUrl(url) {
  const u = String(url ?? "").trim();
  let r = null;
  if (GITHUB_URL.test(u)) r = { app: "github", url: u };
  else if (notionId(u)) r = { app: "notion", url: u, where: { page_id: notionId(u) } };
  else if (/^https:\/\/mail\.google\.com\/.*#[^/?]+\/([0-9a-f]{15,16})$/i.test(u)) r = { app: "gmail", url: u, where: { thread_id: u.match(/([0-9a-f]{15,16})$/i)[1] } };
  else if (/calendar\.google\.com|google\.com\/calendar/.test(u) && /[?&]eid=([^&#]+)/.test(u)) {
    // eid: base64 of "<event id> <calendar id>".
    const [event_id, calendar] = Buffer.from(u.match(/[?&]eid=([^&#]+)/)[1], "base64").toString("utf8").split(" ");
    if (event_id) r = { app: "googlecalendar", url: u, where: { event_id, calendar_id: calendar?.endsWith("@m") ? `${calendar.slice(0, -2)}@gmail.com` : (calendar ?? "primary") } };
  }
  if (!r) return null;
  const ref = shapeRef({ ...r, via: "link" });
  return SHAPES[r.app] && ref.kind !== "item" ? ref : null;
}

// References for one result of a call, and the data the model gets, with `_ref` on each item it can cite:
// a list's items one by one (at most `max`; items: their numbers), anything else as the call's one result (ref).
export function refsOfResult({ app, tool, args, data }, add, { max = 25 } = {}) {
  const located = locatorArgs(args ?? {});
  const shape = data && typeof data === "object" ? inferList(data) : { single: true };
  if (!shape.single) {
    const shown = structuredClone(data);
    const items = [pick(shown, shape.items)].flat().filter((x) => x && typeof x === "object");
    const numbers = [];
    for (const raw of items.slice(0, max)) {
      const id = pick(raw, shape.id);
      const title = pick(raw, shape.title);
      const n = add(shapeRef({ app, tool, via: "item", item: id == null ? undefined : String(id), title: title == null ? undefined : String(title), url: pick(raw, shape.url), where: { ...located, ...idKeys(raw) }, raw }));
      if (n != null) numbers.push((raw._ref = n));
    }
    return { data: shown, ref: null, items: numbers };
  }
  // One thing (a file, an issue, a page): its id fields can be one level down ({ content: { path, sha } }).
  const inner = data && typeof data === "object" ? Object.values(data).filter((v) => v && typeof v === "object" && !Array.isArray(v)) : [];
  const where = { ...located, ...Object.assign({}, ...inner.map((v) => idKeys(v))), ...idKeys(data) };
  const title = firstOf(data, ["title", "subject", "name", "summary", "full_name"]) ?? inner.map((v) => firstOf(v, ["title", "subject", "name", "path"])).find(Boolean);
  const ref = add(shapeRef({ app, tool, via: "call", title: title ?? `${tool} ${Object.values(located).join(" ")}`.trim(), url: findLink(data), where, raw: data }));
  return { data, ref, items: [] };
}

// ---------- Which references an answer used ----------

// The references an answer cites as [n] (also [2, 5]), in the order it cites them. An answer with no marks: the ones
// it names (a link, a path, a title), else what this round read (its calls), else the closest synced knowledge.
export function citedRefs(answer, refs = [], { round, max = 10 } = {}) {
  const byN = new Map(refs.map((r) => [r.n, r]));
  const cited = [];
  for (const m of String(answer ?? "").matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\](?!\()/g)) {
    for (const n of m[1].split(/[,;]/).map((x) => Number(x.trim()))) if (byN.has(n) && !cited.includes(n)) cited.push(n);
  }
  if (cited.length) return cited.slice(0, max).map((n) => byN.get(n));
  const text = String(answer ?? "").toLowerCase();
  const recent = refs.filter((r) => round == null || r.round === round);
  const named = recent.filter((r) => [r.url, r.path, r.title?.length >= 6 ? r.title : null].some((v) => v && text.includes(String(v).toLowerCase())));
  if (named.length) return named.slice(0, max);
  const calls = recent.filter((r) => r.via === "call");
  if (calls.length) return calls.slice(0, max);
  return recent
    .filter((r) => r.via === "knowledge")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.min(3, max));
}

// A reference in one line: "Genterai/genter-cli/src/agent.js", "Genterai/genter-cli #42 Fix paging", an email's subject.
export function refLabel(ref) {
  const w = ref.where ?? {};
  const repo = w.owner && w.repo ? `${w.owner}/${w.repo}` : "";
  if (ref.app === "github" && (ref.kind === "file" || ref.kind === "folder")) return `${repo}/${ref.path ?? ""}`.replace(/\/$/, "");
  if (ref.app === "github" && (ref.kind === "issue" || ref.kind === "pull_request")) {
    const title = ref.title ?? "";
    return `${repo} ${title.startsWith("#") ? title : `#${w.issue_number}${title ? ` ${title}` : ""}`}`;
  }
  if (ref.app === "github" && ref.kind === "repository") return repo;
  return ref.title ?? ref.kind;
}

// ---------- How to write there ----------

// Write tools known to work at a kind of place in a popular app. args: write tool param -> `where` key ("?": may be
// left out); needs: what the caller adds ("?": optional). A file is better changed by edits (fileEditor).
const KNOWN_WRITES = {
  "github:file": [
    {
      tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS",
      args: ["owner", "repo", "path", "branch?"],
      needs: ["message", "content"],
      does: "Replace the whole file (a commit); to change parts of it, edits are better: only those pieces change",
    },
  ],
  "github:folder": [
    { tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", args: ["owner", "repo", "branch?"], needs: ["path", "message", "content"], does: "Add a file in this folder: path is the folder + file name" },
  ],
  "github:issue": [
    { tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", args: ["owner", "repo", "issue_number"], needs: ["body"], does: "Comment on this issue (Markdown)" },
    { tool: "GITHUB_UPDATE_AN_ISSUE", args: ["owner", "repo", "issue_number"], needs: ["title?", "body?", "state?", "labels?", "assignees?"], does: "Change its title, text, state (closed/open), labels or assignees" },
  ],
  "github:pull_request": [
    { tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", args: ["owner", "repo", "issue_number"], needs: ["body"], does: "Comment on this pull request (Markdown)" },
    { tool: "GITHUB_UPDATE_A_PULL_REQUEST", args: ["owner", "repo", "pull_number"], needs: ["title?", "body?", "state?", "base?"], does: "Change its title, description, state or base branch" },
  ],
  "github:repository": [
    { tool: "GITHUB_CREATE_AN_ISSUE", args: ["owner", "repo"], needs: ["title", "body?"], does: "Open an issue in this repository" },
    { tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", args: ["owner", "repo"], needs: ["path", "message", "content", "branch?"], does: "Add or change a file (a commit)" },
  ],
  "github:commit": [
    { tool: "GITHUB_CREATE_A_COMMIT_COMMENT", args: ["owner", "repo", "commit_sha"], needs: ["body"], does: "Comment on this commit" },
  ],
  "gmail:email": [
    { tool: "GMAIL_REPLY_TO_THREAD", args: { thread_id: "thread_id", "recipient_email?": "from" }, needs: ["message_body"], does: "Reply in this email's thread (sends it); recipient_email is its sender" },
    { tool: "GMAIL_CREATE_EMAIL_DRAFT", args: { thread_id: "thread_id", "recipient_email?": "from" }, needs: ["body"], does: "Draft a reply in this thread (not sent); leave subject empty" },
    { tool: "GMAIL_ADD_LABEL_TO_EMAIL", args: ["message_id"], needs: ["add_label_ids?", "remove_label_ids?"], does: "Label or star it, mark it read (remove UNREAD) or archive it (remove INBOX)" },
  ],
  "googlecalendar:event": [
    { tool: "GOOGLECALENDAR_PATCH_EVENT", args: ["calendar_id", "event_id"], needs: ["summary?", "start_time?", "end_time?", "description?", "location?", "attendees?"], does: "Change only the given fields of this event" },
  ],
  "notion:page": [
    { tool: "NOTION_ADD_MULTIPLE_PAGE_CONTENT", args: { parent_block_id: "page_id" }, needs: ["content_blocks"], does: "Add content at the end of this page (blocks: paragraphs, headings, lists; 2000 characters per text)" },
    { tool: "NOTION_UPDATE_PAGE", args: ["page_id"], needs: ["properties?", "icon?"], does: "Change its properties (title, status, dates...) or icon" },
    { tool: "NOTION_CREATE_COMMENT", args: { parent_page_id: "page_id" }, needs: ["comment"], does: "Comment on this page" },
  ],
  "googletasks:task": [
    { tool: "GOOGLETASKS_PATCH_TASK", args: ["tasklist_id", "task_id"], needs: ["title?", "notes?", "status?", "due?"], does: "Change this task, or complete it (status: completed)" },
    { tool: "GOOGLETASKS_INSERT_TASK", args: { tasklist_id: "tasklist_id", task_parent: "task_id" }, needs: ["title", "notes?", "due?"], does: "Add a subtask under it" },
  ],
};

// Write tools for a reference: [{ tool, args, needs, does, read? }], best first. args are filled from `where` and are
// passed as they are; needs is what the caller adds ("?": optional). A popular app's known kind needs no catalogue;
// any other app needs its tools ({ slug, description, inputParameters, tags }, from Composio).
export function writeHints(ref, tools, { limit = 3 } = {}) {
  if (!ref?.app) return [];
  const known = KNOWN_WRITES[`${ref.app}:${ref.kind}`];
  if (known) return known.map((h) => knownHint(h, ref.where ?? {})).filter(Boolean).slice(0, limit);
  return tools?.length ? rankWrites(ref, tools, limit) : [];
}

// ---------- Editing a file: only the pieces that change ----------

// An API commit always carries the whole new file (GitHub's contents and git data APIs have no patch), but nobody has
// to write it out: the file is read (text and sha), exact edits are applied here, and the result is committed once
// with the sha it was read at. fileEditor(ref): how to read and commit a file reference of an app, or null.
const FILE_EDITORS = {
  github: {
    read: (w) => ({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: clean({ owner: w.owner, repo: w.repo, path: w.path, ref: w.branch }) }),
    file(data) {
      const c = data?.content ?? data;
      if (Array.isArray(c) || Array.isArray(data)) throw new Error("this path is a folder, not a file");
      if (typeof c?.content !== "string" || (c.encoding && c.encoding !== "base64")) throw new Error("the file's text did not come back (a file over 1 MB is not read through this API)");
      return { text: Buffer.from(c.content, "base64").toString("utf8"), sha: c.sha };
    },
    // content goes as base64: the tool would take a plain text that happens to be valid base64 for base64.
    write: (w, { text, sha, message }) => ({
      tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS",
      args: clean({ owner: w.owner, repo: w.repo, path: w.path, branch: w.branch, message, content: Buffer.from(text, "utf8").toString("base64"), sha }),
    }),
    link: (data) => data?.commit?.html_url ?? data?.content?.html_url,
  },
};
export function fileEditor(ref) {
  const editor = ref?.kind === "file" && ref.where?.path ? FILE_EDITORS[ref.app] : null;
  if (!editor) return null;
  return { read: editor.read(ref.where), file: editor.file, write: (change) => editor.write(ref.where, change), link: editor.link };
}

// A file's text with edits applied, one after another: { find, replace } replaces the one place `find` is at (exact
// text; found nowhere or more than once is an error, with lines like it to fix `find`), { append } adds at the end,
// { prepend } at the start. The file's line endings are kept.
export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error("edits is empty: pass [{find, replace}] or [{append}]");
  if (text.includes("\u0000")) throw new Error("this is a binary file");
  const crlf = text.includes("\r\n");
  const eol = (v) => (crlf ? String(v ?? "").replace(/\r?\n/g, "\r\n") : String(v ?? ""));
  const nl = crlf ? "\r\n" : "\n";
  let out = text;
  edits.forEach((e, i) => {
    const at = `edit ${i + 1}`;
    if (e?.append != null) {
      out = !out || out.endsWith("\n") ? out + eol(e.append) : out + nl + eol(e.append);
      return;
    }
    if (e?.prepend != null) {
      out = eol(e.prepend) + out;
      return;
    }
    const find = eol(e?.find);
    if (!find) throw new Error(`${at}: find is empty (to add at the end, use append)`);
    const first = out.indexOf(find);
    if (first < 0) throw new Error(`${at}: find is not in the file${linesLike(out, find)}`);
    const count = out.split(find).length - 1;
    if (count > 1) throw new Error(`${at}: find is in the file ${count} times; add the lines around it so it is found once`);
    out = out.slice(0, first) + eol(e.replace) + out.slice(first + find.length);
  });
  return out;
}

// The file's lines most like the first line of a `find` that was not found (most of its words), for the next try.
function linesLike(text, find) {
  const probe = find.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 3);
  if (!probe) return "";
  const words = (l) => new Set(l.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
  const want = words(probe);
  const like = text
    .split(/\r?\n/)
    .map((l, i) => {
      const have = words(l);
      return { n: i + 1, l, score: l.includes(probe) ? Infinity : [...want].filter((w) => have.has(w)).length };
    })
    .filter((x) => x.score >= Math.max(1, want.size / 2))
    .sort((a, b) => b.score - a.score || a.n - b.n)
    .slice(0, 3);
  return like.length ? `; lines like it: ${like.map((x) => `${x.n}: ${JSON.stringify(x.l)}`).join(", ")}` : `; nothing like "${probe.slice(0, 80)}" either: read the file first`;
}

// Whether a reference's writes need the app's catalogue (no known ones for it).
export const needsCatalogue = (ref) => Boolean(ref?.app) && !KNOWN_WRITES[`${ref.app}:${ref.kind}`];

function knownHint(h, where) {
  const pairs = Array.isArray(h.args) ? h.args.map((a) => [a, a.replace(/\?$/, "")]) : Object.entries(h.args);
  const args = {};
  const missing = [];
  for (const [param, key] of pairs) {
    const p = param.replace(/\?$/, "");
    if (where[key] != null && where[key] !== "") args[p] = where[key];
    else if (!param.endsWith("?")) missing.push(p);
  }
  if (!Object.keys(args).length) return null;
  return { tool: h.tool, args, needs: [...missing, ...h.needs], does: h.does };
}

// Any app: its tools that change something (never delete), scored by how much of `where` their params take, by
// whether they take the item itself (its id goes to "<kind>_id", "<kind>Id", "id<Kind>", "<kind>_id_or_key",
// "thread_<id>"...), by whether the tool is about the same thing, and by its verb (change or add to it first, create
// next). A tool with a required id param left empty points at something else and is left out; other unknown required
// params cost a little. The best tool that changes the item and the best that adds to it (a comment, a reply) both
// make the list.
function rankWrites(ref, tools, limit) {
  const prefix = `${String(ref.app).toUpperCase().replace(/-/g, "_")}_`;
  const nouns = new Set([ref.kind, ...nounsOf(ref.tool, ref.app)].filter((n) => n && n !== "item"));
  const scored = [];
  for (const t of tools) {
    const slug = String(t.slug ?? "").toUpperCase();
    if (!slug.startsWith(prefix) || !writes(t)) continue;
    const schema = t.inputParameters ?? t.input_parameters ?? {};
    const props = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    const { args, own } = fillArgs(props, required, ref.where ?? {}, ref.kind);
    const filled = Object.keys(args).length;
    if (!filled) continue;
    const missing = required.filter((p) => !(p in args));
    if (missing.some((p) => ID_PARAM.test(p))) continue; // it points at something else (another issue, a team)
    const about = nounsOf(slug, ref.app).some((n) => nouns.has(n));
    const score =
      filled * 4 +
      (own ? 3 : 0) +
      (about ? 4 : 0) +
      verbScore(slug) -
      missing.filter((p) => !CONTENT_PARAM.test(p)).length * 2 -
      (/_(MULTIPLE|BULK|BATCH)(_|$)/.test(slug) ? 4 : 0) +
      Math.min(props.length, 20) / 100; // ties: the general tool over a one-field one
    if (score <= 0) continue;
    const optional = props.filter((p) => !(p in args) && !required.includes(p) && CONTENT_PARAM.test(p)).slice(0, 4).map((p) => `${p}?`);
    const does = String(t.description ?? "").split(/(?<=\.)\s|\n/)[0].slice(0, 160);
    scored.push({ tool: t.slug, args, needs: [...missing, ...optional], does, score, verb: verbClass(slug) });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = ["change", "add"].map((v) => scored.find((h) => h.verb === v)).filter(Boolean);
  for (const h of scored) if (picked.length < limit && !picked.includes(h)) picked.push(h);
  return picked
    .slice(0, limit)
    .sort((a, b) => b.score - a.score)
    .map(({ score, verb, ...h }) => h);
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const GENERIC_KEYS = new Set(["id", "key", "number", "ts", "uuid", "gid", "identifier", "sha"]);

// Params of a write tool filled from `where`. A required param by the same name (calendarId = calendar_id): the list
// call's own args (owner, a channel, a base) go only where they are needed, so a filter of the list ("assignee: me")
// is never written back. The item itself, by its generic id, under its kind ("issueId", "idCard", "issue_id_or_key"),
// and then as the thread or parent of something new ("thread_ts", "parent_id"), with an id no other param took.
// own: whether the item itself was taken.
function fillArgs(props, required, where, kind) {
  const args = {};
  const entries = Object.entries(where).filter(([, v]) => v != null && v !== "");
  const generic = entries.filter(([k]) => GENERIC_KEYS.has(norm(k)));
  const used = new Set();
  let own = false;
  const named = (np, nk, n) => np === n + nk || np === nk + n || (np.startsWith(n) && np.endsWith(nk) && np.length <= n.length + nk.length + 6);
  const take = (p, hit, item) => {
    args[p] = hit[1];
    used.add(hit[0]);
    if (item) own = true;
  };
  for (const p of props) {
    const np = norm(p);
    const hit = kind && kind !== "item" ? generic.find(([k]) => named(np, norm(k), norm(kind))) : null;
    if (hit) take(p, hit, true);
    else if (required.includes(p)) {
      const same = entries.find(([k]) => norm(k) === np);
      if (same) take(p, same, GENERIC_KEYS.has(norm(same[0])));
    }
  }
  for (const p of props.filter((p) => !(p in args))) {
    const np = norm(p);
    const hit = generic.find(([k]) => !used.has(k) && ["thread", "parent"].some((n) => named(np, norm(k), n)));
    if (hit) take(p, hit, true);
  }
  return { args, own };
}

const verbClass = (slug) =>
  /_(UPDATE|UPDATES|PATCH|EDIT|MODIFY|SET|REPLACE|UPSERT|TRANSITION|MOVE|ASSIGN|COMPLETE|CLOSE|REOPEN)(_|$)/.test(slug)
    ? "change"
    : /_(COMMENT|COMMENTS|REPLY|APPEND|ADD|SEND|POST|CREATE|INSERT)(_|$)/.test(slug)
      ? "add"
      : "other";

const ID_PARAM = /(^id$|_id$|Id$|ID$|^id[A-Z_]|_key$|Key$|^key$|_ts$|^ts$|_number$|^number$|_id_or_key$|IdOrKey$|_sha$|^sha$)/;
const CONTENT_PARAM = /^(body|text|markdown_text|message|content|markdown|title|name|summary|description|notes?|comment|comment_text|subject|status|state|fields|properties)$/i;

const READS = /_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|HISTORY|EXPORT|DOWNLOAD|COUNT|CHECK|DESCRIBE|VIEW|LOOKUP)(_|$)/;
const WRITES = /_(UPDATE|UPDATES|PATCH|EDIT|MODIFY|APPEND|ADD|INSERT|CREATE|POST|SEND|REPLY|COMMENT|SET|REPLACE|UPSERT|WRITE|MOVE|ASSIGN|LABEL|TAG|COMPLETE|CLOSE|REOPEN|TRANSITION|REACT|PIN|STAR|MARK|SHARE|UPLOAD|PUT)(_|$)/;
const DESTROYS = /_(DELETE|DELETES|REMOVE|REMOVES|TRASH|ARCHIVE|DESTROY|PURGE|CLEAR|EMPTY|UNSUBSCRIBE|CANCEL|BULK)(_|$)/;

// A tool that changes something and destroys nothing.
function writes(t) {
  const slug = String(t.slug).toUpperCase();
  const tags = t.tags ?? [];
  if (DESTROYS.test(slug) || tags.includes("destructiveHint")) return false;
  return WRITES.test(slug) || (!READS.test(slug) && !tags.includes("readOnlyHint"));
}

function verbScore(slug) {
  if (/_(UPDATE|UPDATES|PATCH|EDIT|MODIFY|APPEND|ADD|COMMENT|REPLY|SET|REPLACE|UPSERT|TRANSITION|MOVE|ASSIGN|COMPLETE)(_|$)/.test(slug)) return 3;
  if (/_(SEND|POST|CREATE|INSERT|WRITE|PUT)(_|$)/.test(slug)) return 1;
  return 0;
}

// ---------- Small helpers ----------

// The nouns of a tool slug: LINEAR_LIST_LINEAR_ISSUES -> [issue], SLACK_FETCH_CONVERSATION_HISTORY -> [channel, message].
const NOT_NOUN = new Set(
  ("LIST GET FETCH SEARCH FIND READ RETRIEVE QUERY ALL BY ID IDS FOR THE A AN OF IN ON TO FROM WITH AND OR MY " +
    "AUTHENTICATED USING DETAILS DETAIL INFO DATA MULTIPLE SINGLE NEW EXISTING SPECIFIC BATCH JQL POST PUT API V1 V2 V3 " +
    "UPDATE UPDATES PATCH EDIT MODIFY APPEND ADD INSERT CREATE SEND REPLY SET REPLACE UPSERT WRITE MOVE ASSIGN DELETE REMOVE " +
    "ARCHIVE TRASH MARK RAW FULL PAGINATED").split(" "),
);
const SYNONYM = { HISTORY: "message", MESSAGES: "message", CONVERSATION: "channel", CONVERSATIONS: "channel", CONTENT: "file", CONTENTS: "file", ROWS: "record", ROW: "record", ENTRIES: "entry" };
export function nounsOf(slug, app) {
  const appWords = String(app ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const words = String(slug ?? "").toUpperCase().split("_").filter(Boolean);
  return [...new Set(words.filter((w) => !NOT_NOUN.has(w) && !appWords.includes(w) && !/^\d+$/.test(w)).map((w) => SYNONYM[w] ?? stem(w)))];
}

function stem(word) {
  const w = String(word).toLowerCase();
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

const LINK = ["html_url", "web_url", "webViewLink", "htmlLink", "permalink", "url", "link", "webUrl"];
// A link people open (not an API endpoint), at most three levels down.
function findLink(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 3) return undefined;
  for (const k of LINK) if (link(data[k])) return link(data[k]);
  for (const v of Object.values(data)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findLink(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
const link = (v) => (typeof v === "string" && /^https?:\/\/(?!api\.)\S+$/.test(v) ? v : undefined);
const firstOf = (obj, keys) => (obj && typeof obj === "object" ? keys.map((k) => obj[k]).find((v) => typeof v === "string" && v.trim()) : undefined);
const emailOf = (v) => String(v ?? "").match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
const notionId = (url) => String(url ?? "").match(/notion\.(?:so|site)\/(?:[^?#]*?[-/])?([0-9a-f]{32})(?:[?#]|$)/i)?.[1];
const dashed = (id) => (/^[0-9a-f]{32}$/i.test(id) ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id);

// Drops empty fields: undefined, null, "" and "undefined".
function clean(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v != null && v !== "" && v !== "undefined" && !(typeof v === "number" && Number.isNaN(v))));
}
