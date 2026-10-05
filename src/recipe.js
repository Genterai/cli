import { createHash } from "node:crypto";

// Recipe = one successful tool call with fixed, concrete arguments + knowledge about its actual result.
// This file is the pure part: identity, change detection, failure classes, provenance. No I/O, no models.

const sha = (text) => createHash("sha256").update(text).digest("hex");

// Arrays of primitives under these keys are sets: order never matters, duplicates never count.
const SET_KEY = /(ids|labels|tags)$/i;

// Args as one fixed form: keys sorted recursively; undefined, null and "" dropped; strings trimmed; numbers kept;
// arrays keep their order (it can matter) except primitive sets under *ids / *labels / *tags (sorted, deduped).
// Date placeholders ({{today}}) stay as written: they are part of the fixed call.
export function canonicalArgs(value, key = "") {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalArgs(v)).filter((v) => v !== undefined);
    if (SET_KEY.test(key) && items.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      return [...new Set(items)].sort((a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : String(typeof a).localeCompare(typeof b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalArgs(value[k], k);
      if (v === undefined || v === null || v === "") continue;
      out[k] = v;
    }
    return out;
  }
  return value === null ? undefined : value;
}

export const canonicalJson = (args) => JSON.stringify(canonicalArgs(args ?? {}) ?? {});

// "rcp_" + sha256(workspaceId | scope | tool | canonicalArgs)[0..24]. scope = the connected account id ("" when
// the app's default connection was used): two accounts never share a recipe.
export function recipeId({ workspaceId = "", scope = "", tool, args }) {
  return `rcp_${sha([workspaceId, scope ?? "", tool, canonicalJson(args)].join("|")).slice(0, 24)}`;
}

// Bookkeeping that changes with every call without the content changing.
const VOLATILE_KEY = /^(etag|headers|next_?page_?token|next_?page|next_?cursor|cursor|next_?link|request_?id|log_?id|nonce|fetched_?at|x-[\w-]+)$|_url$|Url$/;

function normalize(value, key = "") {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").trim();
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object") {
    let obj = value;
    // GitHub-style file contents: base64 is decoded, so a re-encoding does not count as a change.
    if (obj.encoding === "base64" && typeof obj.content === "string") {
      obj = { ...obj, content: Buffer.from(obj.content.replace(/\s+/g, ""), "base64").toString("utf8"), encoding: undefined };
    }
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      if (VOLATILE_KEY.test(k)) continue;
      const v = normalize(obj[k], k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value === undefined ? undefined : value;
}

// sha256 of the normalized result. Equal hash == "unchanged".
export function contentHash(data) {
  return sha(JSON.stringify(normalize(data) ?? null));
}

// What a result says about being a page of something bigger: next-page tokens, has_more, truncated.
export function isPartial(data) {
  let found = false;
  const walk = (v, depth) => {
    if (found || depth > 4 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.slice(0, 3).forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      if (/^(next_?page_?token|next_?cursor|next_?page|next_?link|nextPageToken|nextCursor|end_?cursor|continuation_?token|next_?token|offset_?next|nextLink)$/i.test(k) && x != null && x !== "" && x !== false) found = true;
      else if (/^(has_?more|hasNextPage|has_?next_?page|is_?truncated|truncated|incomplete_?results|more_?available)$/i.test(k) && x === true) found = true;
      else if (typeof x === "object") walk(x, depth + 1);
      if (found) return;
    }
  };
  walk(data, 0);
  return found;
}

// A failed call, classified. "gone": what the call points to is not there any more. "denied": this account may not
// (or no longer can) see it: forbidden, unauthorized, revoked or expired connection. Anything else (a timeout, a bad
// argument, a rate limit) is null: a transient failure never changes a recipe.
export function classifyFailure(error) {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error ?? "");
  if (!text) return null;
  if (/rate.?limit|too many requests|\b429\b|timed? ?out|timeout|temporar|try again|\b5\d\d\b|econnreset|socket/i.test(text) && !/not found|forbidden/i.test(text)) return null;
  if (/(connected ?account|connection|auth ?config|account) (was |is |has been )?(not found|deleted|revoked|disabled|inactive|expired|removed)|(revoked|invalid[_ ]grant|token (has )?expired|expired token|invalid[_ ]token|bad credentials)/i.test(text)) return "denied";
  if (/not found|\b404\b|does not exist|doesn'?t exist|no longer exists?|was deleted|has been deleted|\bgone\b|\b410\b|no such (file|object|repo|page|item|thread|event|document)|could not find/i.test(text)) return "gone";
  if (/forbidden|\b403\b|unauthori[sz]ed|\b401\b|permission|access denied|not accessible|insufficient (scope|permission)|denied/i.test(text)) return "denied";
  return null;
}

const APP_NAMES = { github: "GitHub", gitlab: "GitLab", googlecalendar: "Google Calendar", googledrive: "Google Drive", googlesheets: "Google Sheets", googledocs: "Google Docs", googletasks: "Google Tasks", gmail: "Gmail", hubspot: "HubSpot", linkedin: "LinkedIn", youtube: "YouTube", onedrive: "OneDrive", outlook: "Outlook", clickup: "ClickUp" };
const appName = (slug) => APP_NAMES[slug] ?? slug.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// Arg names that say where a call points, outermost first. Generic: no connector knows more than its arg names.
const PATH_KEYS = ["workspace", "workspace_id", "team", "org", "organization", "owner", "workspace_slug", "project", "project_id", "database_id", "repo", "repository", "space", "base_id", "spreadsheet_id", "document_id", "calendarId", "calendar_id", "tasklist_id", "tasklist", "channel", "channel_id", "mailbox", "label", "folder", "folder_id", "folder_name", "parent_id", "page_id", "branch", "ref", "path", "file_path", "filename", "id", "number", "issue_number", "pull_number", "thread_id", "message_id"];
const LINK_KEYS = ["html_url", "web_url", "webViewLink", "htmlLink", "permalink", "web_link", "webLink", "url", "link"];

// Where a call's result lives, for humans: { app: "GitHub", path: ["Genter", "src/auth.ts"], url }. Found from the
// call's arg names and the result's own link; never from connector-specific code.
export function sourceOf({ tool = "", args = {}, toolkit, data } = {}) {
  const slug = String(toolkit || tool.split("_")[0] || "").toLowerCase();
  const path = [];
  for (const key of PATH_KEYS) {
    const v = args?.[key];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim() !== "" && !String(v).includes("{{")) {
      const text = String(v).trim();
      if (!path.includes(text)) path.push(text);
    }
  }
  let url = null;
  const scan = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    for (const key of LINK_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && /^https?:\/\/(?!api\.)/.test(v)) return v;
    }
    return null;
  };
  url = scan(data) ?? scan(data?.data) ?? scan(data?.content) ?? scan(data?.details) ?? null;
  return { app: slug ? appName(slug) : null, path: path.slice(0, 6), url };
}

// A stored record as the current model needs it. Legacy records ({ memory, kind, alias, live }) map onto it; alias,
// sync records and records that were never recipes (no memory: unlisted results) return null. Embeddings and
// summaries of ordinary recipes are kept. Non-destructive: the stored row is only replaced on the next execute.
export function normalizeLegacy(record) {
  if (!record || typeof record !== "object") return null;
  if (record.removed || record.alias || record.kind === "sync") return null;
  const legacy = Boolean(record.memory) || (!record.scope && !record.status);
  if (!legacy) return record;
  if (!record.memory) return null;
  const { memory, live, sync, kind, ready, unrelated, unsummarized, ...rest } = record;
  const description = String(memory.description ?? "");
  const title = description.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").replace(/[`*_]/g, "").trim().slice(0, 100) || rest.tool;
  return {
    ...rest,
    title: rest.title ?? title,
    short: rest.short ?? memory.short ?? title,
    scope: rest.scope ?? { account: memory.account ?? "", toolkit: String(rest.tool ?? "").split("_")[0].toLowerCase() },
    status: memory.status === "outdated" ? "stale" : "fresh",
    ...(memory.disabled && { disabled: memory.disabled }),
    partial: Boolean(rest.partial),
    updated_at: rest.updated_at ?? memory.created_at ?? rest.created_at,
    checked_at: rest.checked_at ?? rest.created_at ?? memory.created_at,
    trigger: rest.trigger ?? { active: false, spec: null, id: null },
    source: rest.source ?? { app: null, path: [], url: null },
    legacy: true,
  };
}

// A record without its vectors, for lists and pages.
export function publicRecipe(record) {
  if (!record) return null;
  const { summaryEmbedding, itemEmbeddings, memory, ...rest } = record;
  return rest;
}
