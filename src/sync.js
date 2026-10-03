import { createHash } from "node:crypto";

// Sources: an app's content (a GitHub repo, Notion pages) kept as searchable knowledge.
// The engine knows nothing about a connector. A template maps the connector's tools onto roles:
//   list: pages of items with { id, version, title, url, size }   (required)
//   read: an item -> its text                                       (required unless list gives the text)
// A sync lists everything, reads only items whose version changed, and drops items that are gone,
// so the first sync is a full one, every next one is incremental, and a sync cut short just continues next time.
// Texts are split into chunks, embedded, encrypted and stored per item: rows { source_id, key, blob }.
// Depth, the same for every connector:
//   titles  — only what list returns (titles, paths, links); nothing is read. Cheap; finds by name, the agent opens live.
//   summary — every item is read, only a short summary is kept and embedded.
//   full    — the whole text, in chunks.
// Changing a source's depth re-processes its items on the next sync.
//
// setup (optional): calls made before listing that fill scope fields left empty, e.g. a repo's default branch.
// Template values may use {{name}}: scope fields, {{item.<path>}}, {{page}} (the pagination cursor).
// A placeholder that is the whole value keeps its type; a missing one drops the argument.

const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|flac|exe|dll|so|dylib|bin|class|pyc|o|a|wasm|map|min\.(js|css)|lock|sqlite|db)$/i;

export const TEMPLATES = {
  github: {
    toolkit: "github",
    name: "GitHub repository",
    title: "{{owner}}/{{repo}}",
    scope: {
      owner: { required: true, description: "Repository owner (user or organization)" },
      repo: { required: true, description: "Repository name" },
      branch: { description: "Branch, tag or commit; the default branch if empty" },
      path: { description: "Only files under this folder, e.g. docs/" },
    },
    setup: [{ tool: "GITHUB_GET_A_REPOSITORY", args: { owner: "{{owner}}", repo: "{{repo}}" }, set: { branch: "data.default_branch" } }],
    list: {
      tool: "GITHUB_GET_A_TREE",
      args: { owner: "{{owner}}", repo: "{{repo}}", tree_sha: "{{branch}}", recursive: true },
      items: "data.tree",
      where: { type: "blob" },
      id: "path",
      version: "sha",
      title: "path",
      size: "size",
      url: "https://github.com/{{owner}}/{{repo}}/blob/{{branch}}/{{item.path}}",
    },
    read: {
      tool: "GITHUB_GET_REPOSITORY_CONTENT",
      args: { owner: "{{owner}}", repo: "{{repo}}", path: "{{item.id}}", ref: "{{branch}}" },
      text: "data.content.content",
      encoding: "data.content.encoding",
    },
    prefix: "{{path}}",
    exclude: [BINARY, /(^|\/)(node_modules|vendor|dist|build|\.git|\.next|coverage)\//, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/],
    maxSize: 300_000,
  },
  notion: {
    toolkit: "notion",
    name: "Notion pages",
    title: "Notion{{query? · }}{{query}}",
    scope: {
      query: { description: "Only pages whose title matches; all pages shared with Genter if empty" },
    },
    list: {
      tool: "NOTION_SEARCH_NOTION_PAGE",
      args: { query: "{{query}}", filter_property: "object", filter_value: "page", page_size: 100, start_cursor: "{{page}}" },
      items: "data.results",
      skip: { archived: true, in_trash: true },
      id: "id",
      version: "last_edited_time",
      title: ["properties.title.title.0.plain_text", "properties.*.title.0.plain_text"],
      url: "url",
      next: "data.next_cursor",
    },
    read: {
      tool: "NOTION_GET_PAGE_MARKDOWN",
      args: { page_id: "{{item.id}}" },
      text: "data.markdown",
    },
  },
};

const LIMITS = { maxItems: 3000, maxPages: 100, maxChunks: 80, chunkSize: 1600, overlap: 200, readers: 6, embedBatch: 64 };

// run(tool, args, account) -> Composio result; embedMany(texts) -> vectors; seal/open: encryption; store: see below.
// store: getSource(id), putSource({id, blob}), deleteSource(id), sources() -> [{id, blob}],
//        items(sourceId) -> [{source_id, key, blob}], putItems(rows), deleteItems(sourceId, keys), allItems() -> rows
// namespace: the user or workspace, so ids and running syncs never mix between them.
export const DEPTHS = ["titles", "summary", "full"];

export function createSources({ run, embedMany, summarize, seal, open, store, namespace = "" }) {
  const loadSource = async (id) => {
    const row = await store.getSource(id);
    if (!row) throw new Error(`Unknown source: ${id}`);
    return open(row.blob);
  };
  const saveSource = (source) => store.putSource({ id: source.id, blob: seal(source) });

  // Lists every item of a source, page by page.
  async function list(source, template) {
    const role = template.list;
    const out = [];
    let page;
    for (let n = 0; n < LIMITS.maxPages; n++) {
      const res = await run(role.tool, fill(role.args, { ...source.scope, page }), source.account);
      if (res?.successful === false) throw new Error(`${role.tool}: ${errorText(res.error)}`);
      for (const raw of [pick(res, role.items)].flat().filter(Boolean)) {
        if (role.where && !Object.entries(role.where).every(([p, v]) => pick(raw, p) === v)) continue;
        if (role.skip && Object.entries(role.skip).some(([p, v]) => pick(raw, p) === v)) continue;
        const id = pick(raw, role.id);
        if (id == null) continue;
        const ctx = { ...source.scope, item: raw };
        out.push({
          id: String(id),
          version: String(pick(raw, role.version) ?? ""),
          title: String(pick(raw, role.title) ?? id),
          url: role.url?.includes("{{") ? fill(role.url, ctx) : role.url ? pick(raw, role.url) : undefined,
          size: role.size ? Number(pick(raw, role.size)) || 0 : undefined,
          text: role.text ? pick(raw, role.text) : undefined,
        });
        if (out.length > LIMITS.maxItems) {
          throw new Error(`More than ${LIMITS.maxItems} items in ${source.title}. Narrow the source down (a folder, a query).`);
        }
      }
      const next = role.next && pick(res, role.next);
      if (!next) break;
      page = next;
    }
    const prefix = template.prefix ? String(fill(template.prefix, source.scope) ?? "").replace(/^\/+/, "") : "";
    return out.filter(
      (i) =>
        i.id.startsWith(prefix) &&
        !(template.exclude ?? []).some((re) => re.test(i.id)) &&
        !(template.maxSize && i.size > template.maxSize),
    );
  }

  // The text of one item: from the list itself, or with the read role.
  async function read(source, template, item) {
    if (item.text != null) return String(item.text);
    const role = template.read;
    const res = await run(role.tool, fill(role.args, { ...source.scope, item: { ...item, id: item.id } }), source.account);
    if (res?.successful === false) throw new Error(errorText(res.error));
    let text = pick(res, role.text);
    if (text == null) return "";
    if (role.encoding && pick(res, role.encoding) === "base64") text = Buffer.from(String(text), "base64").toString("utf8");
    text = String(text);
    return text.includes("\u0000") ? "" : text; // binary content
  }

  // Fills scope fields left empty (setup calls). Saved with the source, so it runs once.
  async function setup(source, template) {
    for (const step of template.setup ?? []) {
      const missing = Object.keys(step.set).filter((k) => source.scope[k] == null);
      if (!missing.length) continue;
      const res = await run(step.tool, fill(step.args, source.scope), source.account);
      if (res?.successful === false) throw new Error(`${step.tool}: ${errorText(res.error)}`);
      for (const k of missing) {
        const v = pick(res, step.set[k]);
        if (v != null) source.scope[k] = String(v);
      }
    }
  }

  async function syncNow(source, { budgetMs = 240_000 } = {}) {
    const template = templateOf(source);
    const started = Date.now();
    const stats = { listed: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, errors: [] };
    try {
      await setup(source, template);
      const listed = await list(source, template);
      stats.listed = listed.length;
      const known = new Map(
        (await store.items(source.id)).map((row) => {
          const { id, version, depth } = open(row.blob);
          return [id, { key: row.key, id, version, depth: depth ?? "full" }];
        }),
      );
      const seen = new Set(listed.map((i) => i.id));
      const gone = [...known.values()].filter((k) => !seen.has(k.id));
      if (gone.length) await store.deleteItems(source.id, gone.map((k) => k.key));
      stats.removed = gone.length;
      const depth = source.depth ?? "full";
      const todo = listed.filter((i) => known.get(i.id)?.version !== i.version || known.get(i.id)?.depth !== depth || !i.version);
      stats.unchanged = listed.length - todo.length;

      let next = 0;
      const worker = async () => {
        while (next < todo.length && Date.now() - started < budgetMs) {
          const item = todo[next++];
          try {
            let chunks;
            let summary;
            if (depth === "titles") {
              chunks = [`${item.title}${item.url ? `\n${item.url}` : ""}`];
            } else {
              const text = await read(source, template, item);
              if (depth === "summary" && text.trim()) {
                summary = (await summarize?.(item.title, text)) || text.slice(0, 600);
                chunks = [summary];
              } else {
                chunks = chunk(text);
              }
            }
            const vectors = await embedChunks(item.title, chunks);
            const key = itemKey(source.id, item.id);
            const record = {
              id: item.id,
              version: item.version,
              depth,
              title: item.title,
              url: item.url,
              chunks: chunks.map((t, i) => ({ text: t, embedding: toB64(vectors[i]) })),
            };
            await store.putItems([{ source_id: source.id, key, blob: seal(record) }]);
            if (known.has(item.id)) stats.updated++;
            else stats.added++;
          } catch (e) {
            stats.failed++;
            if (stats.errors.length < 5) stats.errors.push(`${item.title}: ${e.message}`.slice(0, 300));
          }
        }
      };
      await Promise.all(Array.from({ length: LIMITS.readers }, worker));
      const left = todo.length - stats.added - stats.updated - stats.failed;
      const rows = await store.items(source.id);
      source.stats = { items: rows.length, chunks: rows.reduce((n, r) => n + cachedItem(r, open).chunks.length, 0) };
      source.status = left > 0 ? "partial" : stats.failed ? "errors" : "ready";
      source.last_run = { ...stats, left, ms: Date.now() - started, at: new Date().toISOString() };
      if (left === 0) source.synced_at = source.last_run.at;
    } catch (e) {
      source.status = "failed";
      source.last_run = { ...stats, error: e.message, ms: Date.now() - started, at: new Date().toISOString() };
    }
    await saveSource(source);
    return publicSource(source);
  }

  async function embedChunks(title, chunks) {
    const out = [];
    for (let i = 0; i < chunks.length; i += LIMITS.embedBatch) {
      out.push(...(await embedMany(chunks.slice(i, i + LIMITS.embedBatch).map((t) => `${title}\n\n${t}`))));
    }
    return out;
  }

  const api = {
    templates: () =>
      Object.entries(TEMPLATES).map(([key, t]) => ({ template: key, toolkit: t.toolkit, name: t.name, scope: t.scope })),

    async list() {
      return (await store.sources()).map((row) => publicSource(open(row.blob))).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async get(id) {
      return publicSource(await loadSource(id));
    },

    // Adds a source from a template; the same scope is not added twice. Call sync to fill it.
    // Same template + scope again: the existing source, with the new depth if one is given.
    async create({ template, scope = {}, account, depth }) {
      if (depth && !DEPTHS.includes(depth)) throw new Error(`depth is one of ${DEPTHS.join(", ")}`);
      const t = TEMPLATES[template];
      if (!t) throw new Error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(", ")}`);
      const clean = {};
      for (const [name, field] of Object.entries(t.scope)) {
        const value = String(scope[name] ?? "").trim() || field.default;
        if (field.required && !value) throw new Error(`${name} is required: ${field.description}`);
        if (value) clean[name] = value;
      }
      const id = `src_${createHash("sha256").update(`${namespace}:${template}:${JSON.stringify(clean)}`).digest("hex").slice(0, 16)}`;
      const existing = await store.getSource(id);
      if (existing) {
        const source = open(existing.blob);
        if (depth && depth !== source.depth) await saveSource(Object.assign(source, { depth, status: "partial" }));
        return publicSource(source);
      }
      const source = {
        id,
        template,
        toolkit: t.toolkit,
        title: fill(t.title, clean),
        scope: clean,
        account,
        depth: depth ?? "full",
        status: "new",
        created_at: new Date().toISOString(),
        stats: { items: 0, chunks: 0 },
      };
      await saveSource(source);
      return publicSource(source);
    },

    // Brings a source up to date. Shared by concurrent callers; budgetMs stops early, the next sync continues.
    async sync({ id, budgetMs }) {
      const key = `${namespace}:${id}`;
      if (!running.has(key)) {
        running.set(
          key,
          (async () => {
            const source = await loadSource(id);
            source.status = "syncing";
            source.sync_started_at = new Date().toISOString();
            await saveSource(source);
            return syncNow(source, { budgetMs });
          })().finally(() => running.delete(key)),
        );
      }
      return running.get(key);
    },

    async remove({ id }) {
      const rows = await store.items(id);
      if (rows.length) await store.deleteItems(id, rows.map((r) => r.key));
      await store.deleteSource(id);
      return { id, removed: true };
    },

    // Chunks closest to the query, across sources (or one): { source, title, url, text, score }.
    async search({ vector, limit = 6, source, minScore = 0.3 }) {
      if (!vector) return [];
      const titles = new Map((await store.sources()).map((row) => [row.id, open(row.blob).title]));
      const hits = [];
      for (const row of await store.allItems()) {
        if (source && row.source_id !== source) continue;
        const item = cachedItem(row, open);
        for (const c of item.chunks) {
          const score = cosine(vector, c.vector);
          if (score >= minScore) hits.push({ source: row.source_id, source_title: titles.get(row.source_id), title: item.title, url: item.url, text: c.text, score });
        }
      }
      // Best chunk per item first, so one long file does not fill every slot.
      hits.sort((a, b) => b.score - a.score);
      const perItem = new Map();
      const out = [];
      for (const h of hits) {
        const k = `${h.source}:${h.title}`;
        if ((perItem.get(k) ?? 0) >= 2) continue;
        perItem.set(k, (perItem.get(k) ?? 0) + 1);
        out.push({ ...h, score: Number(h.score.toFixed(2)) });
        if (out.length >= limit) break;
      }
      return out;
    },
  };
  return api;
}

const running = new Map(); // "<namespace>:<source id>" -> Promise of its sync, so a source never syncs twice at once

const templateOf = (source) => {
  const t = TEMPLATES[source.template];
  if (!t) throw new Error(`Unknown template "${source.template}"`);
  return t;
};

// What callers see of a source: no account internals. A sync that died with its process (no update for
// 10 minutes) shows as partial, so it can be continued.
const publicSource = ({ id, template, toolkit, title, scope, depth, status, sync_started_at, created_at, synced_at, stats, last_run }) => ({
  id,
  template,
  toolkit,
  title,
  scope,
  depth: depth ?? "full",
  status: status === "syncing" && Date.now() - new Date(sync_started_at).getTime() > 600_000 ? "partial" : status,
  created_at,
  synced_at: synced_at ?? null,
  stats,
  last_run: last_run ?? null,
});

const itemKey = (sourceId, itemId) => createHash("sha256").update(`${sourceId}:${itemId}`).digest("hex").slice(0, 32);

// Decrypted items with their vectors, cached by blob (a new seal has a new iv).
const itemCache = new Map();
function cachedItem(row, open) {
  const key = `${row.source_id}:${row.key}:${row.blob.slice(0, 40)}`;
  let item = itemCache.get(key);
  if (!item) {
    const raw = open(row.blob);
    item = { ...raw, chunks: raw.chunks.map((c) => ({ text: c.text, vector: fromB64(c.embedding) })) };
    itemCache.set(key, item);
    if (itemCache.size > 50000) itemCache.delete(itemCache.keys().next().value);
  }
  return item;
}

// Text in overlapping chunks, cut at line breaks when possible.
export function chunk(text, { size = LIMITS.chunkSize, overlap = LIMITS.overlap, max = LIMITS.maxChunks } = {}) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!s) return [];
  const out = [];
  let start = 0;
  while (start < s.length && out.length < max) {
    let end = Math.min(s.length, start + size);
    if (end < s.length) {
      const nl = s.lastIndexOf("\n", end);
      if (nl > start + size / 2) end = nl;
    }
    out.push(s.slice(start, end).trim());
    if (end >= s.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
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

const errorText = (e) => (typeof e === "string" ? e : JSON.stringify(e ?? "failed")).slice(0, 500);

const toB64 = (v) => Buffer.from(Float32Array.from(v).buffer).toString("base64");
const fromB64 = (s) => new Float32Array(Uint8Array.from(Buffer.from(s, "base64")).buffer);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}
