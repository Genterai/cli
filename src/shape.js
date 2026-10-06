// Generic helpers for reading tool results and args (no connector-specific code).

// The args of a call that point somewhere (owner, repo, channel, calendarId, tasklist_id...), not how it pages,
// sorts or filters. Scalars only; placeholders left unfilled are dropped.
const NOT_LOCATOR =
  /^(page|page_?token|page_?cursor|start_?cursor|cursor|next|after|before|offset|per_?page|page_?size|limit|max_?results|max|first|last|count|sort|sort_?by|direction|order|order_?by|since|until|q|query|search|text|state|status|fields|expand|verbose|format|time_?min|time_?max|recursive|archived|all|jql|view|properties|associations|show_?\w+|include_?\w*|exclude_?\w*|filter_?\w*|label_?ids|single_?events)$/i;
export function locatorArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args ?? {}).filter(([k, v]) => (typeof v === "string" || typeof v === "number") && v !== "" && !NOT_LOCATOR.test(k) && !String(v).includes("{{")),
  );
}

// The id fields of an item (id, number, path, sha, ts, threadId, issue_key...), scalars only: what a write call
// needs to point at it again.
const ID_KEY = /^(id|key|number|path|sha|ts|slug|uuid|gid|identifier)$|(_id|Id|ID|_key|Key|_ts|_number|_uuid|_sha)$/;
export function idKeys(obj, max = 8) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (Object.keys(out).length >= max) break;
    if (ID_KEY.test(k) && (typeof v === "string" || typeof v === "number") && v !== "" && String(v).length <= 300) out[k] = v;
  }
  return out;
}


// "{{owner}}/{{repo}}" with values; a whole-value placeholder keeps its type; missing ones drop the arg.
// "{{query? · }}" prints the text after "?" only when query is set.
export function fill(value, ctx) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([\w.*]+)\}\}$/);
    if (whole) return pick(ctx, whole[1]);
    return value
      .replace(/\{\{(\w+)\?([^}]*)\}\}/g, (_, k, text) => (pick(ctx, k) != null ? text : ""))
      .replace(/\{\{([\w.*]+)\}\}/g, (_, p) => {
        const v = pick(ctx, p);
        return v == null ? "" : String(v);
      });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, fill(v, ctx)])
        .filter(([, v]) => v !== undefined && v !== ""),
    );
  }
  return value;
}

// pick(obj, "data.results"), "a.0.b", "properties.*.title" (* = the first key where the rest is found);
// an array of paths: the first one found.
export function pick(obj, path) {
  if (Array.isArray(path)) {
    for (const p of path) {
      const v = pick(obj, p);
      if (v != null) return v;
    }
    return undefined;
  }
  if (path == null || path === "") return obj;
  const [head, ...rest] = String(path).split(".");
  if (obj == null || typeof obj !== "object") return undefined;
  if (head === "*") {
    for (const v of Object.values(obj)) {
      const found = pick(v, rest.join("."));
      if (found != null) return found;
    }
    return undefined;
  }
  return pick(obj[head], rest.join("."));
}


// The shape of a call's result, found in a real response: the biggest list of objects, and in its items an id,
// a version and a title (a commit's is its message: GitHub lists commits with no title of their own). No list: the whole response is one item (re-read every sync).
// path before sha: in a file tree the path is the file, the sha its version.
const ID = ["id", "uuid", "messageId", "message_id", "ts", "number", "key", "path", "sha", "gid", "name"];
const VERSION = ["updated_at", "updatedAt", "modifiedTime", "modified_time", "last_edited_time", "lastModified", "updated", "etag", "historyId", "edited.ts", "internalDate", "sha", "ts"];
const TITLE = ["subject", "title", "name", "summary", "full_name", "commit.message", "displayName", "display_name", "text", "snippet", "label", "email", "filename", "path"];
const LINK = ["html_url", "web_url", "webViewLink", "htmlLink", "permalink", "url", "link"];

export function inferList(response) {
  let best = null;
  const walk = (v, path, depth) => {
    if (depth > 5 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const objects = v.filter((x) => x && typeof x === "object" && !Array.isArray(x));
      if (objects.length && objects.length >= v.length / 2 && (!best || objects.length > best.n)) best = { path, n: objects.length, sample: objects };
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(response, "", 0);
  if (!best) return { single: true, text: "@item" };
  const has = (key) => best.sample.every((x) => pick(x, key) != null && pick(x, key) !== "");
  const id = ID.find((k) => has(k) && new Set(best.sample.map((x) => String(pick(x, k)))).size === best.sample.length);
  if (!id) return { single: true, text: "@item" };
  // No version field: items that do not change (messages), so the id is the version and each is read once.
  const version = VERSION.find((k) => k !== id && has(k)) ?? id;
  const title = TITLE.find((k) => best.sample.every((x) => typeof pick(x, k) === "string")) ?? id;
  // A link people open, not an API endpoint (a tree's "url" is api.github.com).
  const url = LINK.find((k) => best.sample.every((x) => /^https?:\/\/(?!api\.)/.test(String(pick(x, k) ?? ""))));
  const size = best.sample.every((x) => typeof x.size === "number") ? "size" : undefined;
  return { items: best.path, id, ...(version && { version }), title, ...(url && { url }), ...(size && { size }), text: "@item" };
}

