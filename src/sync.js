import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { jsonToMarkdown } from "./markdown.js";

// Sources: an app's content (a GitHub repo, Notion pages) kept as searchable knowledge.
// The engine knows nothing about a connector. A live sync recipe (plain JSON, built by the agent from any app's tools,
// tested on real data and saved like other recipes; GitHub and Notion are built in) maps the app's tools onto roles:
//   list: pages of items with { id, version, title, url, size }   (required; next = cursor path, or nextPage: true)
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
// choices (optional): what can be picked to sync (a user's repos, top-level pages), each mapped to scope fields,
//   so nobody types owner/repo by hand.
// triggers (optional): Composio triggers that mean "this source changed"; an event syncs it (only changes are read).
//   A spec may have a fallback, used when it can not be created (e.g. no admin rights for a repo webhook).
// setup (optional): calls made before listing that fill scope fields left empty, e.g. a repo's default branch.
// Template values may use {{name}}: scope fields, {{item.<path>}}, {{page}} (the pagination cursor).
// A placeholder that is the whole value keeps its type; a missing one drops the argument.

// Source filters (per source, any app): include/exclude are regexes over "<id> <title>", maxItems caps the list.
// list.text "@item": the item itself as Markdown (no read call); list.fields: only these paths of it, as plain text
// (an issue's title, state, labels and its whole body). list.single: the whole response is one item.
// list.title may be a template: "#{{item.number}} {{item.title}}".
// list.append: keep items that left the list (streams: mail, chat) instead of removing them.
// A list without items/id is shaped from its first real response (inferList): a ready recipe needs only the call.
// Every call recipe can be synced: inferList finds the list, id, version and title in a real response.
// Updates: the recipe's triggers, or a schedule ({ every: minutes }); store rows carry next_sync_at for the scheduler.
// A recipe with no triggers may say how often its sources are checked (every: minutes): set when a source is made.
// list.complete: a path that is false when a response is not the whole list (a crawl cut short by time); the items
// it did not list are kept then.
// A sync cut short by its time budget (partial) is due again a minute later, so the scheduler finishes it.
//
// A recipe with no parameters: vars hold its fixed values ({ owner, repo, branch }), used like scope fields, so the
// recipe is one call to make and nothing to fill in. parts: several lists in one recipe, e.g. a repository's files,
// its issues and pull requests, and its description: [{ key, name, list, read?, bulk?, exclude?, maxSize? }].
// Item ids get the part's key ("files:src/a.js"); a part that fails keeps what it had and the others go on.
// bulk (optional, on a part with read): a call that returns a link to a .tar.gz of everything (a repository's
// archive). When many items changed, their texts come from that one download instead of a read per item.

const BINARY = "\\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|flac|exe|dll|so|dylib|bin|class|pyc|o|a|wasm|map|min\\.(js|css)|lock|sqlite|db)$";

// Built-in live sync recipes; also the examples the agent learns the format from.
export const BUILTIN = {
  github: {
    toolkit: "github",
    name: "GitHub repository",
    description: "The files of a repository (code and docs; not issues or pull requests), kept up to date on every commit.",
    title: "{{owner}}/{{repo}}",
    choices: {
      tool: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
      args: { per_page: 100, sort: "pushed", page: "{{page}}" },
      items: "data.repositories",
      skip: { archived: true },
      pages: 3,
      label: "full_name",
      hint: "description",
      updated: "pushed_at",
      private: "private",
      scope: { owner: "owner.login", repo: "name" },
      nextPage: true,
    },
    triggers: [
      {
        slug: "GITHUB_COMMIT_EVENT",
        config: { owner: "{{owner}}", repo: "{{repo}}" },
        label: "on every commit",
        fallback: {
          slug: "GITHUB_BRANCH_CHANGED_TRIGGER",
          config: { owner: "{{owner}}", repo: "{{repo}}", branch: "{{branch}}", interval: 5 },
          label: "within 5 minutes of a push",
        },
      },
    ],
    scope: {
      owner: { required: true, description: "Repository owner (user or organization)", example: "Genterai" },
      repo: { required: true, description: "Repository name", example: "genter-cli" },
      branch: { description: "Branch, tag or commit; the default branch if empty", example: "main" },
      path: { description: "Only files under this folder", example: "docs/" },
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
    exclude: [BINARY, "(^|/)(node_modules|vendor|dist|build|\\.git|\\.next|coverage)/", "(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml)$"],
    maxSize: 300_000,
  },
  website: {
    toolkit: "website",
    name: "Website",
    description: "The pages of a website: its address and the pages it links to on the same site, up to two links deep, checked every hour.",
    title: "{{url}}",
    scope: {
      url: { required: true, description: "The site's address: this page and the pages under it that it links to", example: "https://docs.example.com" },
      depth: { description: "How many links deep from the address: 0 (only it), 1 or 2 (default)", example: "2" },
    },
    every: 60, // a site has no triggers: checked hourly, only changed pages are embedded again
    list: {
      tool: "WEBSITE_CRAWL", // local (web.js)
      args: { url: "{{url}}", depth: "{{depth}}" },
      items: "data.pages",
      complete: "data.complete",
      id: "url",
      version: "hash",
      title: "title",
      url: "url",
      size: "size",
      text: "text",
    },
  },
  notion: {
    toolkit: "notion",
    name: "Notion pages",
    description: "A Notion page and every page under it (or all pages shared with Genter), kept up to date on every edit.",
    title: "Notion{{name? · }}{{name}}{{query? · }}{{query}}",
    choices: {
      tool: "NOTION_SEARCH_NOTION_PAGE",
      args: { filter_property: "object", filter_value: "page", page_size: 100, start_cursor: "{{page}}" },
      items: "data.results",
      where: { "parent.type": "workspace" },
      skip: { archived: true, in_trash: true },
      next: "data.next_cursor",
      pages: 5,
      label: ["properties.title.title.0.plain_text", "properties.*.title.0.plain_text"],
      updated: "last_edited_time",
      scope: { root: "id", name: ["properties.title.title.0.plain_text", "properties.*.title.0.plain_text"] },
    },
    triggers: [
      { slug: "NOTION_PAGE_CONTENT_UPDATED", config: {}, label: "on every edit" },
      { slug: "NOTION_PAGE_CREATED", config: {}, label: "on new pages" },
    ],
    scope: {
      root: { description: "A page: it and every page under it; all pages shared with Genter if empty" },
      name: { description: "The page's title, for display", display: true },
      query: { description: "Only pages whose title matches", example: "Roadmap" },
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
      parent: "parent.page_id",
      next: "data.next_cursor",
    },
    root: "{{root}}",
    read: {
      tool: "NOTION_GET_PAGE_MARKDOWN",
      args: { page_id: "{{item.id}}" },
      text: "data.markdown",
    },
  },
};

// batch: items read, embedded and stored together; bulkMin: changed items of a part that make its bulk download worth it.
const LIMITS = { maxItems: 10000, maxPages: 100, maxChunks: 80, chunkSize: 1600, overlap: 200, readers: 8, embedBatch: 64, batch: 48, bulkMin: 15, bulkBytes: 150_000_000 };

// run(tool, args, account) -> Composio result; embedMany(texts) -> vectors; seal/open: encryption; store: see below.
// store: getSource(id), putSource({id, blob}), deleteSource(id), sources() -> [{id, blob}],
//        items(sourceId) -> [{source_id, key, blob}], putItems(rows), deleteItems(sourceId, keys), allItems() -> rows
// namespace: the user or workspace, so ids and running syncs never mix between them.
export const DEPTHS = ["titles", "summary", "full"];

// triggers (optional): create(slug, config, account) -> trigger id (re-enables the same one if it exists), disable(id), remove(id).
// recipes (optional): saved live sync recipes, get(id) -> recipe | null, list() -> [{ id, recipe }].
export function createSources({ run, embedMany, summarize, triggers, recipes, seal, open, store, namespace = "", onSync }) {
  const loadSource = async (id) => {
    const row = await store.getSource(id);
    if (!row) throw new Error(`Unknown source: ${id}`);
    return open(row.blob);
  };
  // When the scheduler runs a source next: a partial sync continues in a minute; a running one is retried in
  // 10 minutes in case its process dies; otherwise its schedule, if any.
  const nextAt = (source) =>
    source.status === "partial"
      ? new Date(Date.now() + 60_000).toISOString()
      : source.status === "syncing"
        ? new Date(Date.now() + 600_000).toISOString()
        : (source.schedule?.next ?? null);
  const saveSource = (source) => store.putSource({ id: source.id, blob: seal(source), next_sync_at: nextAt(source) });
  // A recipe by key: built in (github, notion) or saved by the agent.
  const recipeOf = async (key) => {
    const recipe = BUILTIN[key] ?? (recipes ? await recipes.get(key) : null);
    if (!recipe) throw new Error(`Unknown live sync recipe "${key}"`);
    return recipe;
  };
  const templateOf = (source) => recipeOf(source.template);
  // Same recipe + scope (display-only fields aside) = same source.
  const sourceId = (key, recipe, clean) => {
    const keyed = Object.fromEntries(Object.entries(clean).filter(([k]) => !recipe.scope?.[k]?.display));
    return `src_${createHash("sha256").update(`${namespace}:${key}:${JSON.stringify(keyed)}`).digest("hex").slice(0, 16)}`;
  };

  // The containers a recipe's list runs over: [{ id, label }], the newest/first `max` (default 20).
  async function containers(each, source, template, depth, max) {
    if (depth > 3) throw new Error("Containers nest deeper than 3 levels");
    const limit = max ?? each.max ?? 20;
    const parents = each.each ? await containers(each.each, source, template, depth + 1, max) : [null];
    const out = [];
    for (const p of parents) {
      const ctx = { ...ctxOf(source, template), ...(p && { container: p.id, container_label: p.label }) };
      const res = await run(each.tool, fill(each.args ?? {}, ctx), source.account);
      if (res?.successful === false) throw new Error(`${each.tool}: ${errorText(res.error)}`);
      // Containers given only as a call: their list, id and name found in the response.
      const shape = each.items ? each : { ...inferList(res), ...each };
      for (const raw of [pick(res, shape.items)].flat().filter(Boolean)) {
        if (!matches(raw, each) || raw.archived === true || raw.deleted === true) continue;
        const id = pick(raw, shape.id);
        if (id == null) continue;
        out.push({ id: String(id), label: `${p ? `${p.label} / ` : ""}${pick(raw, each.label ?? shape.title ?? shape.id) ?? id}` });
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  // One run of the list role (all its pages) with extra placeholders, items appended to out.
  async function listFrom(source, role, extra, { pages, raw, part, template }, out) {
    let page;
    // Excluded and too big items never count toward the item limit (a repo's node_modules, binaries).
    const exclude = (part.exclude ?? []).map((x) => new RegExp(x, "i"));
    const dropped = (id, size) => exclude.some((re) => re.test(id)) || (part.maxSize && size > part.maxSize);
    const base = { ...ctxOf(source, template), ...extra };
    // Where items are in the app, for references and writes: the list call's own args that point somewhere
    // (owner, repo, a channel, a task list), plus each item's id fields.
    const located = locatorArgs(fill(role.args ?? {}, base));
    for (let n = 0; n < pages; n++) {
      // nextPage: numbered pages (1, 2, ...) until one comes back empty; otherwise the cursor from list.next.
      if (role.nextPage) page = n + 1;
      const res = await run(role.tool, fill(role.args ?? {}, { ...base, page }), source.account);
      if (res?.successful === false) throw new Error(`${role.tool}: ${errorText(res.error)}`);
      if (role.complete && pick(res, role.complete) === false) out.cut = true;
      // A list given only as a call: its items, id, version and title are found in the first real response.
      if (n === 0 && !role.single && !role.items) {
        role = shaped(role, res);
        if (role.nextPage) page = 1;
      }
      if (role.single) {
        // The whole response is the item, versioned by its content (only the kept fields, when there are some).
        const data = res?.data ?? res;
        const ctx = { ...base, item: data };
        out.push({
          id: extra.container ?? "all",
          version: hash(role.fields ? project(data, role.fields) : data),
          title: (isTemplate(role.title) && fill(role.title, ctx)) || extra.container_label || part.name || source.title,
          url: isTemplate(role.url) ? fill(role.url, ctx) : role.url ? pick(data, role.url) : undefined,
          text: (role.fields && fieldsText(data, role.fields)) || jsonToMarkdown(data),
          where: { ...located, ...idKeys(data) },
        });
        break;
      }
      const found = [pick(res, role.items)].flat().filter(Boolean);
      if (raw && !found.length && !raw.length) raw.push({ response: res });
      for (const item of found) {
        if (raw && raw.length < 2) raw.push(item);
      }
      for (const raw of found) {
        if (!matches(raw, role)) continue;
        const id = pick(raw, role.id);
        if (id == null) continue;
        if (dropped(String(id), role.size ? Number(pick(raw, role.size)) || 0 : 0)) continue;
        const ctx = { ...base, item: raw };
        out.push({
          id: String(id),
          version: role.version === "@fields" && role.fields ? hash(project(raw, role.fields)) : String(pick(raw, role.version) ?? ""),
          title: isTemplate(role.title) ? String(fill(role.title, ctx) || id) : String(pick(raw, role.title) ?? id),
          url: isTemplate(role.url) ? fill(role.url, ctx) : role.url ? pick(raw, role.url) : undefined,
          size: role.size ? Number(pick(raw, role.size)) || 0 : undefined,
          text: role.text === "@item" ? (role.fields && fieldsText(raw, role.fields)) || jsonToMarkdown(raw) : role.text ? pick(raw, role.text) : undefined,
          parent: role.parent ? pick(raw, role.parent) : undefined,
          where: { ...located, ...idKeys(raw) },
          raw, // for read args like {{item.path}}; never stored
        });
        if (out.length > LIMITS.maxItems) {
          throw new Error(`More than ${LIMITS.maxItems} items in ${source.title}. Narrow the source down (a folder, a query).`);
        }
      }
      if (role.nextPage) {
        // A page shorter than the page size asked for is the last one: no call for an empty page after it.
        const size = Number(pick(role.args ?? {}, ["per_page", "page_size", "pageSize", "limit", "maxResults", "max_results"])) || 0;
        if (!found.length || (size && found.length < size)) break;
        continue;
      }
      const next = role.next && pick(res, role.next);
      if (!next) break;
      page = next;
    }
  }

  // Every item of one part, page by page, with the part's own prefix, root and exclusions applied.
  async function listPart(source, template, part, { pages, raw, containersMax, vars = {} }) {
    const role = part.list;
    const out = [];
    // each: the list runs once per container (a label, a channel...), found by its own call, nested up to 3 levels.
    if (role.each) {
      const found = await containers(role.each, source, template, 0, containersMax);
      for (const c of found) {
        const before = out.length;
        await listFrom(source, role, { ...vars, container: c.id, container_label: c.label }, { pages, raw, part, template }, out);
        for (const item of out.slice(before)) {
          item.id = `${c.id}/${item.id}`;
          item.title = `${c.label} · ${item.title}`;
        }
      }
    } else {
      await listFrom(source, role, vars, { pages, raw, part, template }, out);
    }
    const ctx = ctxOf(source, template);
    const prefix = part.prefix ? String(fill(part.prefix, ctx) ?? "").replace(/^\/+/, "") : "";
    // A root: only it and the items under it, by the parent links in the list itself.
    const root = part.root ? fill(part.root, ctx) : null;
    const parents = new Map(out.map((i) => [i.id, i.parent]));
    const under = (id) => {
      for (let n = 0, cur = id; cur && n < 30; n++, cur = parents.get(cur)) if (cur === root) return true;
      return false;
    };
    const exclude = (part.exclude ?? []).map((x) => new RegExp(x, "i"));
    const kept = out.filter((i) => (!root || under(i.id)) && i.id.startsWith(prefix) && !exclude.some((re) => re.test(i.id)) && !(part.maxSize && i.size > part.maxSize));
    kept.cut = out.cut; // not the whole list: what it missed is kept
    return kept;
  }

  // Lists every item of a source: { items, failed, incremental }. Each item knows its part (index) and its id within
  // it (local); a recipe with parts prefixes ids with the part's key. One part of several may fail: it is in failed,
  // the rest go on. A part whose args use {{since}} lists only what changed since its last complete sync
  // (incremental: the items it does not list are kept), and everything again once a week.
  // raw (optional) collects the first raw items, for a test.
  async function list(source, template, { pages = LIMITS.maxPages, raw, containersMax } = {}) {
    const parts = partsOf(template);
    const out = [];
    const failed = [];
    const incremental = [];
    for (const [index, part] of parts.entries()) {
      const mark = usesSince(part) && source.since?.[part.key || "_"];
      const since = mark && Date.now() - new Date(mark.full).getTime() < 7 * 86_400_000 ? mark.at : undefined;
      if (since) incremental.push(part.key);
      const vars = since ? { since, since_unix: Math.floor(new Date(since).getTime() / 1000) } : {};
      try {
        const items = await listPart(source, template, part, { pages, raw, containersMax, vars });
        if (items.cut && !since) incremental.push(part.key);
        for (const item of items) {
          item.part = index;
          item.local = item.id;
          if (part.key) item.id = `${part.key}:${item.id}`;
          out.push(item);
        }
      } catch (e) {
        if (parts.length === 1) throw e;
        failed.push({ key: part.key, error: `${part.name ?? part.key}: ${e.message}`.slice(0, 300) });
      }
    }
    if (parts.length > 1 && failed.length === parts.length) throw new Error(failed.map((f) => f.error).join("; "));
    const filter = source.filter ?? {};
    const include = filter.include ? new RegExp(filter.include, "i") : null;
    const skip = filter.exclude ? new RegExp(filter.exclude, "i") : null;
    // An item listed twice (pages that shift while they are read) counts once.
    const ids = new Set();
    const kept = out.filter((i) => !ids.has(i.id) && ids.add(i.id) && (!include || include.test(`${i.id} ${i.title}`)) && !(skip && skip.test(`${i.id} ${i.title}`)));
    return { items: filter.maxItems ? kept.slice(0, filter.maxItems) : kept, failed, incremental };
  }

  // The text of one item: from the list itself, or with its part's read role.
  async function read(source, template, item) {
    if (item.text != null) return String(item.text);
    const role = partsOf(template)[item.part ?? 0]?.read;
    if (!role) return "";
    const { raw, ...listed } = item;
    const res = await run(role.tool, fill(role.args, { ...ctxOf(source, template), item: { ...raw, ...listed, id: item.local ?? item.id } }), source.account);
    if (res?.successful === false) throw new Error(errorText(res.error));
    // A read given only as a call: the text is found in the response.
    const at = role.text ?? inferText(res);
    let text = pick(res, at?.text ?? at);
    if (text == null) return "";
    const encoding = role.encoding ?? at?.encoding;
    if (encoding && pick(res, encoding) === "base64") text = Buffer.from(String(text), "base64").toString("utf8");
    text = typeof text === "string" ? text : jsonToMarkdown(text);
    return text.includes("\u0000") ? "" : text; // binary content
  }

  // The texts of a part's items in one download (a repository's archive): Map(local id -> text).
  async function bulkTexts(source, template, part, wanted) {
    const { bulk } = part;
    const res = await run(bulk.tool, fill(bulk.args ?? {}, ctxOf(source, template)), source.account);
    if (res?.successful === false) throw new Error(`${bulk.tool}: ${errorText(res.error)}`);
    const url = pick(res, bulk.url);
    if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error(`${bulk.tool}: no download link`);
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`archive download failed: ${r.status}`);
    if (Number(r.headers.get("content-length")) > LIMITS.bulkBytes) {
      await r.body?.cancel();
      throw new Error("archive too big, reading files one by one");
    }
    const gz = Buffer.from(await r.arrayBuffer());
    return untar(gunzipSync(gz, { maxOutputLength: LIMITS.bulkBytes * 4 }), { strip: bulk.strip ?? 1, wanted });
  }

  // Fills scope fields left empty (setup calls). Saved with the source, so it runs once.
  async function setup(source, template) {
    for (const step of template.setup ?? []) {
      const missing = Object.keys(step.set).filter((k) => source.scope[k] == null && template.vars?.[k] == null);
      if (!missing.length) continue;
      const res = await run(step.tool, fill(step.args, ctxOf(source, template)), source.account);
      if (res?.successful === false) throw new Error(`${step.tool}: ${errorText(res.error)}`);
      for (const k of missing) {
        const v = pick(res, step.set[k]);
        if (v != null) source.scope[k] = String(v);
      }
    }
  }

  async function syncNow(source, { budgetMs = 240_000, reason } = {}) {
    const template = await templateOf(source);
    const parts = partsOf(template);
    const started = Date.now();
    const stats = { listed: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, errors: [] };
    const error = (text) => stats.errors.length < 5 && stats.errors.push(String(text).slice(0, 300));
    try {
      await setup(source, template);
      const { items: listed, failed: failedParts, incremental } = await list(source, template);
      for (const f of failedParts) error(f.error);
      stats.listed = listed.length;
      // What is kept: id -> { key, version, depth, chunks }, read from the store once.
      const known = new Map(
        (await store.items(source.id)).map((row) => {
          const item = cachedItem(row, open);
          return [item.id, { key: row.key, id: item.id, version: item.version, depth: item.depth ?? "full", chunks: item.chunks.length }];
        }),
      );
      // A part that could not be listed, or listed only what changed, keeps its items; so does a list that only
      // appends (mail, chat).
      const keptParts = [...failedParts.map((f) => f.key), ...incremental].map((k) => `${k}:`);
      const appendOnly = parts.length === 1 && (parts[0].list?.append || incremental.length > 0);
      const seen = new Set(listed.map((i) => i.id));
      const gone = appendOnly ? [] : [...known.values()].filter((k) => !seen.has(k.id) && !keptParts.some((p) => k.id.startsWith(p)));
      if (gone.length) await store.deleteItems(source.id, gone.map((k) => k.key));
      for (const k of gone) known.delete(k.id);
      stats.removed = gone.length;
      const depth = source.depth ?? "full";
      const todo = listed.filter((i) => known.get(i.id)?.version !== i.version || known.get(i.id)?.depth !== depth || !i.version);
      stats.unchanged = listed.length - todo.length;

      // Many changed items of a part with a bulk call (a repository's archive): their texts in one download.
      const toRead = (i) => depth !== "titles" && i.text == null && parts[i.part]?.read;
      const bulks = new Map();
      const bulkOf = (index) => {
        if (!bulks.has(index)) {
          const wanted = new Set(todo.filter((i) => i.part === index && toRead(i)).map((i) => i.local));
          bulks.set(
            index,
            bulkTexts(source, template, parts[index], wanted).catch((e) => {
              error(`${parts[index].name ?? "bulk"}: ${e.message}`);
              return null;
            }),
          );
        }
        return bulks.get(index);
      };
      const wantsBulk = new Set(parts.map((p, index) => index).filter((index) => parts[index].bulk && todo.filter((i) => i.part === index && toRead(i)).length >= LIMITS.bulkMin));
      const textOf = async (item) => {
        if (wantsBulk.has(item.part) && toRead(item)) {
          const hit = (await bulkOf(item.part))?.get(item.local);
          if (hit != null) return hit;
        }
        return read(source, template, item);
      };

      // In batches: texts read side by side, every chunk of the batch embedded in a few calls, stored together.
      let done = 0;
      while (done < todo.length && Date.now() - started < budgetMs) {
        const batch = todo.slice(done, done + LIMITS.batch);
        done += batch.length;
        const prepared = await mapPool(batch, LIMITS.readers, async (item) => {
          try {
            if (depth === "titles") return { item, chunks: [`${item.title}${item.url ? `\n${item.url}` : ""}`] };
            const text = await textOf(item);
            if (depth === "summary" && text.trim()) return { item, chunks: [(await summarize?.(item.title, text)) || text.slice(0, 600)] };
            return { item, chunks: chunk(text) };
          } catch (e) {
            stats.failed++;
            error(`${item.title}: ${e.message}`);
            return null;
          }
        });
        const ready = prepared.filter(Boolean);
        let vectors;
        try {
          vectors = await embedAll(ready.flatMap(({ item, chunks }) => chunks.map((t) => `${item.title}\n\n${t}`)));
        } catch (e) {
          stats.failed += ready.length;
          error(`embeddings: ${e.message}`);
          continue;
        }
        let k = 0;
        const rows = ready.map(({ item, chunks }) => {
          const record = {
            id: item.id,
            version: item.version,
            depth,
            title: item.title,
            url: item.url,
            ...(item.where && Object.keys(item.where).length && { where: item.where }),
            chunks: chunks.map((t) => ({ text: t, embedding: toB64(vectors[k++]) })),
          };
          return { source_id: source.id, key: itemKey(source.id, item.id), blob: seal(record) };
        });
        await store.putItems(rows);
        for (const { item, chunks } of ready) {
          if (known.has(item.id)) stats.updated++;
          else stats.added++;
          known.set(item.id, { id: item.id, version: item.version, depth, chunks: chunks.length });
        }
      }
      const left = todo.length - done;
      // Items and chunks kept, and items per part ("files", "issues"...).
      const all = [...known.values()];
      const byPart = {};
      if (parts.length > 1) for (const p of parts) byPart[p.key] = all.filter((i) => i.id.startsWith(`${p.key}:`)).length;
      source.stats = { items: all.length, chunks: all.reduce((n, i) => n + i.chunks, 0), ...(parts.length > 1 && { parts: byPart }) };
      source.status = left > 0 ? "partial" : stats.failed || failedParts.length ? "errors" : "ready";
      source.last_run = { ...stats, left, ms: Date.now() - started, at: new Date().toISOString() };
      if (left === 0) {
        source.synced_at = source.last_run.at;
        // Parts that list by {{since}}: the next sync lists what changed from a little before this one started.
        const at = new Date(started - 300_000).toISOString();
        for (const p of parts.filter((p) => usesSince(p) && !failedParts.some((f) => f.key === p.key))) {
          const k = p.key || "_";
          source.since = { ...source.since, [k]: { at, full: incremental.includes(p.key) ? source.since[k].full : new Date(started).toISOString() } };
        }
      }
    } catch (e) {
      source.status = "failed";
      source.last_run = { ...stats, error: e.message, ms: Date.now() - started, at: new Date().toISOString() };
    }
    // A done or failed sync waits for its next turn; a partial one is due again in a minute (nextAt).
    if (source.schedule) source.schedule.next = new Date(Date.now() + source.schedule.every * 60_000).toISOString();
    await saveSource(source);
    const out = publicSource(source);
    // The host logs every run (e.g. a feed of calls); a failing log never fails the sync.
    if (onSync) await Promise.resolve(onSync(out, { reason: reason ?? "manual" })).catch(() => {});
    return out;
  }

  // Embeddings of many texts: up to embedBatch per call, three calls at a time, in order.
  async function embedAll(texts) {
    const groups = [];
    for (let i = 0; i < texts.length; i += LIMITS.embedBatch) groups.push(texts.slice(i, i + LIMITS.embedBatch));
    return (await mapPool(groups, 3, (g) => embedMany(g))).flat();
  }

  // Every kept item with its vectors, decrypted once per change: with a store that lists stamps, only rows that
  // changed since the last search are loaded, so a search does not pull every embedding from the database.
  async function keptItems(only) {
    if (!store.itemStamps || !store.itemsByKey) {
      return (await store.allItems()).filter((row) => !only || only.has(row.source_id)).map((row) => ({ row, item: cachedItem(row, open) }));
    }
    const stamps = (await store.itemStamps()).filter((r) => !only || only.has(r.source_id));
    const missing = stamps.filter((r) => rowCache.get(`${r.source_id}:${r.key}`)?.stamp !== String(r.stamp));
    const stampOf = new Map(missing.map((r) => [`${r.source_id}:${r.key}`, String(r.stamp)]));
    for (let i = 0; i < missing.length; i += 500) {
      for (const row of await store.itemsByKey(missing.slice(i, i + 500))) {
        const stamp = stampOf.get(`${row.source_id}:${row.key}`) ?? "";
        rowCache.set(`${row.source_id}:${row.key}`, { stamp, row: { source_id: row.source_id, key: row.key }, item: cachedItem(row, open) });
      }
    }
    if (rowCache.size > 60000) for (const k of [...rowCache.keys()].slice(0, rowCache.size - 60000)) rowCache.delete(k);
    return stamps.map((r) => rowCache.get(`${r.source_id}:${r.key}`)).filter((x) => x?.item);
  }

  const api = {
    // Live sync recipes: built in, then saved ones. { template, toolkit, name, description, scope, choices, triggers, builtin }.
    async templates() {
      const saved = recipes ? await recipes.list() : [];
      return [...Object.entries(BUILTIN).map(([id, recipe]) => ({ id, recipe, builtin: true })), ...saved].map(({ id, recipe, builtin }) => ({
        template: id,
        toolkit: recipe.toolkit,
        name: recipe.name,
        description: recipe.description ?? "",
        scope: recipe.scope ?? {},
        ...(recipe.parts?.length && { parts: recipe.parts.map((p) => p.name ?? p.key) }),
        choices: Boolean(recipe.choices),
        triggers: (recipe.triggers ?? []).map((x) => x.label),
        builtin: Boolean(builtin),
      }));
    },

    // A tool's real response, clipped: for whoever writes a recipe, to see the paths.
    // raw: the whole response (for code), not clipped.
    async probe({ tool, args = {}, account, raw = false }) {
      const res = await run(tool, args, account);
      return raw ? res : clip(res);
    },

    // Tries a live sync recipe on real data without saving anything: checks its shape, lists the first page,
    // reads two items. Returns what came out and the first raw items, so wrong paths can be fixed.
    async test({ recipe, scope = {}, account }) {
      const problems = checkRecipe(recipe);
      if (problems.length) return { ok: false, problems };
      const source = { id: "test", title: "test", scope: cleanScope(recipe, scope, { strict: false }), account };
      const raw = [];
      try {
        await setup(source, recipe);
        const { items } = await list(source, recipe, { pages: 1, raw, containersMax: 2 });
        const sample = [];
        for (const item of items.slice(0, 2)) {
          const text = await read(source, recipe, item).catch((e) => `ERROR: ${e.message}`);
          sample.push({ id: item.id, title: item.title, version: item.version, url: item.url, text: text.slice(0, 400), length: text.length });
        }
        const issues = [
          !items.length && "list returned no items: check list.items (see raw) and where/skip",
          items.length && items.every((i) => !i.version) && "no versions: every sync would re-read everything; map list.version",
          sample.some((x) => x.text.startsWith("ERROR")) && "read failed for an item",
          sample.length && sample.every((x) => !x.length) && "read returned empty text: check read.text",
        ].filter(Boolean);
        return { ok: !issues.length, problems: issues, scope: source.scope, first_page: items.length, items: items.slice(0, 5).map(({ id, title, version, url }) => ({ id, title, version, url })), sample, raw: clip(raw) };
      } catch (e) {
        return { ok: false, problems: [e.message], raw: clip(raw) };
      }
    },

    async list() {
      return (await store.sources()).map((row) => publicSource(open(row.blob))).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async get(id) {
      return publicSource(await loadSource(id));
    },

    // Adds a source from a template; the same scope is not added twice. Call sync to fill it.
    // Same template + scope again: the existing source, with the new depth if one is given.
    // filter (optional): { include, exclude, maxItems } — regexes over "<id> <title>", e.g. include "^docs/".
    async create({ template, scope = {}, account, depth, filter, recipe_of }) {
      if (depth && !DEPTHS.includes(depth)) throw new Error(`depth is one of ${DEPTHS.join(", ")}`);
      const t = await recipeOf(template);
      const clean = cleanScope(t, scope);
      const id = sourceId(template, t, clean);
      const existing = await store.getSource(id);
      if (existing) {
        const source = open(existing.blob);
        const changed = (depth && depth !== source.depth) || (filter && JSON.stringify(cleanFilter(filter)) !== JSON.stringify(source.filter ?? {}));
        if (changed) await saveSource(Object.assign(source, { ...(depth && { depth }), ...(filter && { filter: cleanFilter(filter) }), status: "partial" }));
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
        filter: filter ? cleanFilter(filter) : undefined,
        recipe_of,
        status: "new",
        created_at: new Date().toISOString(),
        stats: { items: 0, chunks: 0 },
        ...(t.every && { schedule: { every: t.every, next: new Date(Date.now() + t.every * 60_000).toISOString() } }),
      };
      await saveSource(source);
      return publicSource(source);
    },

    // What can be picked to sync with this template (repos, top-level pages), newest first, each with its scope
    // and the source already made from it, if any: [{ label, hint, updated, private, scope, source }].
    async choices({ template, account }) {
      const t = await recipeOf(template);
      const role = t.choices;
      if (!role) return [];
      const out = [];
      let page;
      for (let n = 0; n < (role.pages ?? 1); n++) {
        const res = await run(role.tool, fill(role.args, { page: role.nextPage ? n + 1 : page }), account);
        if (res?.successful === false) throw new Error(`${role.tool}: ${errorText(res.error)}`);
        const items = [pick(res, role.items)].flat().filter(Boolean);
        for (const raw of items) {
          if (!matches(raw, role)) continue;
          const scope = {};
          for (const [k, p] of Object.entries(role.scope)) {
            const v = pick(raw, p);
            if (v != null && v !== "") scope[k] = String(v);
          }
          out.push({
            label: String(pick(raw, role.label) ?? "Untitled"),
            hint: role.hint ? (pick(raw, role.hint) ?? null) : null,
            updated: role.updated ? (pick(raw, role.updated) ?? null) : null,
            private: role.private ? Boolean(pick(raw, role.private)) : null,
            scope,
          });
        }
        if (role.nextPage) {
          if (!items.length) break;
        } else {
          page = role.next && pick(res, role.next);
          if (!page) break;
        }
      }
      const known = new Map((await store.sources()).map((row) => open(row.blob)).map((src) => [src.id, publicSource(src)]));
      return out
        .map((c) => ({ ...c, source: known.get(sourceId(template, t, cleanScope(t, c.scope, { strict: false }))) ?? null }))
        .sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
    },

    // Brings a source up to date. Shared by concurrent callers; budgetMs stops early, the next sync continues.
    // again: if a sync is running, run once more after it (an event arrived mid-sync), instead of piling up.
    // reason: why it runs (manual | trigger | schedule | live), passed on to onSync.
    async sync({ id, budgetMs, again = false, reason }) {
      const key = `${namespace}:${id}`;
      if (running.has(key)) {
        if (again) rerun.add(key);
        return running.get(key);
      }
      // Another process (a page's next round, the scheduler) is on it right now: its state, not a second sync.
      // A trigger event always syncs, so a change that came mid-sync is not lost.
      if (reason !== "trigger") {
        const current = await loadSource(id);
        if (current.status === "syncing" && Date.now() - new Date(current.sync_started_at).getTime() < 150_000) return publicSource(current);
      }
      const job = (async () => {
        let out;
        do {
          rerun.delete(key);
          const source = await loadSource(id);
          source.status = "syncing";
          source.sync_started_at = new Date().toISOString();
          await saveSource(source);
          out = await syncNow(source, { budgetMs, reason });
        } while (rerun.has(key));
        return out;
      })().finally(() => running.delete(key));
      running.set(key, job);
      return job;
    },

    // Syncs a source every `every` minutes (null: off); the host's scheduler runs sources whose next_sync_at is due.
    async schedule({ id, every }) {
      const source = await loadSource(id);
      source.schedule = every ? { every: Number(every), next: new Date(Date.now() + Number(every) * 60_000).toISOString() } : undefined;
      await saveSource(source);
      return publicSource(source);
    },

    // Keeps a source up to date by itself: turns its template's triggers on (or off). A trigger that can not be
    // created falls back to its fallback (e.g. polling); what could not be turned on is in watch_error.
    async watch({ id, on = true }) {
      if (!triggers) throw new Error("Triggers are not available here");
      const source = await loadSource(id);
      const t = await templateOf(source);
      if (on) {
        if (source.watch?.length) return publicSource(source);
        if (!t.triggers?.length) throw new Error(`${t.name} has no triggers`);
        await setup(source, t);
        const made = [];
        const errors = [];
        for (const spec of t.triggers) {
          let error;
          for (let cur = spec; cur; cur = cur.fallback) {
            try {
              made.push({ id: await triggers.create(cur.slug, fill(cur.config, ctxOf(source, t)), source.account), slug: cur.slug, label: cur.label });
              error = null;
              break;
            } catch (e) {
              error = `${cur.slug}: ${e.message}`;
            }
          }
          if (error) errors.push(error);
        }
        source.watch = made;
        source.watch_error = errors.length ? errors.join("; ").slice(0, 500) : undefined;
      } else {
        // Composio may share one trigger between sources (same app, same config): remove it only when unused.
        const others = new Set(
          (await store.sources())
            .map((row) => open(row.blob))
            .filter((src) => src.id !== id)
            .flatMap((src) => (src.watch ?? []).map((w) => w.id)),
        );
        // Disabled, not deleted: turning it on again reuses it instead of adding another webhook to the app.
        for (const w of source.watch ?? []) if (!others.has(w.id)) await (triggers.disable ?? triggers.remove)(w.id).catch(() => {});
        source.retired = [...new Set([...(source.retired ?? []), ...(source.watch ?? []).map((w) => w.id)])];
        source.watch = [];
        source.watch_error = undefined;
      }
      await saveSource(source);
      return publicSource(source);
    },

    // A trigger fired: sync every source it belongs to. Events during a sync fold into one more sync.
    async onTrigger({ triggerId, budgetMs }) {
      const ids = new Set([triggerId].flat().filter(Boolean));
      const hit = (await store.sources()).map((row) => open(row.blob)).filter((src) => (src.watch ?? []).some((w) => ids.has(w.id)));
      return Promise.all(hit.map((src) => api.sync({ id: src.id, budgetMs, again: true, reason: "trigger" })));
    },

    async remove({ id }) {
      if (triggers) {
        if ((await loadSource(id)).watch?.length) await api.watch({ id, on: false });
        // Its triggers go too, unless another source uses them.
        const source = await loadSource(id);
        const others = new Set(
          (await store.sources())
            .map((row) => open(row.blob))
            .filter((src) => src.id !== id)
            .flatMap((src) => [...(src.watch ?? []).map((w) => w.id), ...(src.retired ?? [])]),
        );
        for (const t of source.retired ?? []) if (!others.has(t)) await triggers.remove(t).catch(() => {});
      }
      const rows = await store.items(id);
      if (rows.length) await store.deleteItems(id, rows.map((r) => r.key));
      await store.deleteSource(id);
      return { id, removed: true };
    },

    // Chunks closest to the query, across sources (or one): { source, title, url, text, score }.
    // source: one source id or several. Hits carry the recipe the source keeps (recipe_of), if any, and where the
    // item is in its app: { toolkit, item (its id), part, tool (the list call), where (owner, repo, path, ids...) }.
    async search({ vector, limit = 6, source, minScore = 0.3 }) {
      if (!vector) return [];
      const only = source ? new Set([source].flat()) : null;
      const info = new Map((await store.sources()).map((row) => [row.id, open(row.blob)]));
      const hits = [];
      for (const { row, item } of await keptItems(only)) {
        for (const c of item.chunks) {
          const score = cosine(vector, c.vector);
          if (score >= minScore) {
            const src = info.get(row.source_id);
            hits.push({ source: row.source_id, source_title: src?.title, recipe_of: src?.recipe_of ?? null, title: item.title, url: item.url, text: c.text, score, id: item.id, where: item.where });
          }
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
      const templates = new Map();
      for (const h of out) {
        const src = info.get(h.source);
        if (!src) continue;
        if (!templates.has(src.template)) templates.set(src.template, await recipeOf(src.template).catch(() => null));
        const { id, where } = h;
        delete h.id;
        Object.assign(h, { toolkit: src.toolkit ?? null, ...locate(src, templates.get(src.template), { id, where }) });
      }
      return out;
    },
  };
  return api;
}

const running = new Map(); // "<namespace>:<source id>" -> Promise of its sync, so a source never syncs twice at once
const rowCache = new Map(); // "<source id>:<key>" -> { stamp, row, item }: kept items for search, by the store's stamp
const rerun = new Set(); // keys to sync once more when their running sync ends

// where: every path must equal its value; skip: none may. The value "*" means the path is there at all
// (GitHub's issue list also has pull requests: skip { "pull_request": "*" }).
const is = (raw, p, v) => (v === "*" ? pick(raw, p) != null : pick(raw, p) === v);
export const matches = (raw, role) =>
  (!role.where || Object.entries(role.where).every(([p, v]) => is(raw, p, v))) && !(role.skip && Object.entries(role.skip).some(([p, v]) => is(raw, p, v)));

// The parts of a recipe: its parts, or the recipe itself as one part (no key, so its item ids stay as they are).
export const partsOf = (t) =>
  t.parts?.length ? t.parts : [{ key: "", list: t.list, read: t.read, bulk: t.bulk, exclude: t.exclude, maxSize: t.maxSize, prefix: t.prefix, root: t.root }];

// Placeholders of a source: the recipe's fixed values, the source's scope, and dates ({{ago.30d}}, {{ahead.365d}}, {{now}}).
function ctxOf(source, template) {
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const span = (sign) => Object.fromEntries([1, 7, 30, 90, 180, 365].map((d) => [`${d}d`, at(sign * d)]));
  return { now: at(0), ago: span(-1), ahead: span(1), ...template?.vars, ...source.scope };
}

// Where a kept item is in its app: its id within its part, the part, the list call, and `where`: the recipe's fixed
// values and the source's scope, the list call's args that point somewhere, then the item's own id fields (kept since
// items carry them; older items get the rest).
function locate(source, template, { id, where }) {
  const parts = template ? partsOf(template) : [];
  const part = parts.find((p) => p.key && String(id).startsWith(`${p.key}:`)) ?? (parts.length === 1 ? parts[0] : null);
  const item = part?.key ? String(id).slice(part.key.length + 1) : String(id);
  const scope = Object.fromEntries(Object.entries(source.scope ?? {}).filter(([k]) => !template?.scope?.[k]?.display));
  const listed = part?.list?.args ? locatorArgs(fill(part.list.args, ctxOf(source, template))) : {};
  return { item, part: part?.key || null, tool: part?.list?.tool ?? null, where: { ...locatorArgs({ ...template?.vars, ...scope }), ...listed, ...where } };
}

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

const usesSince = (part) => JSON.stringify(part.list?.args ?? {}).includes("{{since");
const isTemplate = (v) => typeof v === "string" && v.includes("{{");
const hash = (v) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);

// Values at a path, through arrays: "labels.name" of an issue -> ["bug", "ui"].
function gather(obj, path) {
  const [head, ...rest] = String(path).split(".");
  if (obj == null) return undefined;
  if (Array.isArray(obj)) return obj.map((x) => gather(x, path)).flat().filter((x) => x != null && x !== "");
  if (typeof obj !== "object") return undefined;
  const v = obj[head];
  return rest.length ? gather(v, rest.join(".")) : v;
}

// Only the given paths of an object: { "user.login": "dan", labels: [...] }.
function project(obj, fields) {
  return Object.fromEntries(fields.map((f) => [f, gather(obj, f)]).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)));
}

// An item as plain text for embeddings: short fields as "name: value" lines, long texts (a body) in full below them.
function fieldsText(obj, fields) {
  const lines = [];
  const long = [];
  for (const [f, v] of Object.entries(project(obj, fields))) {
    const text = Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (text.length > 200 || text.includes("\n")) long.push(text);
    else lines.push(`${f.replace(/[._]/g, " ")}: ${text}`);
  }
  return [lines.join("\n"), ...long].filter(Boolean).join("\n\n");
}

// A list role given only as a call, shaped from a real response: items, id, version, title, url (inferList),
// and how it pages when "{{page}}" is in its args: a token or cursor arg follows the cursor found in the response
// (none: one page), any other (page, page_number) counts pages.
function shaped(role, res) {
  const shape = inferList(res);
  const arg = Object.entries(role.args ?? {}).find(([, v]) => v === "{{page}}")?.[0];
  let next = {};
  if (arg && !role.next && !role.nextPage) {
    const cursor = /token|cursor|after|start|offset/i.test(arg);
    next = cursor ? { next: inferNext(res) ?? "__none__" } : { nextPage: true };
  }
  return { ...shape, ...next, ...role };
}

// Where the next page's cursor is in a response: nextPageToken, next_cursor, ... up to three levels down.
function inferNext(res) {
  const NEXT = /^(next_?page_?token|next_?cursor|next_?page_?cursor|end_?cursor|cursor|next)$/i;
  const walk = (v, path, depth) => {
    if (depth > 3 || v == null || typeof v !== "object" || Array.isArray(v)) return null;
    for (const [k, x] of Object.entries(v)) {
      const at = path ? `${path}.${k}` : k;
      if (NEXT.test(k) && (typeof x === "string" || typeof x === "number")) return at;
    }
    for (const [k, x] of Object.entries(v)) {
      const found = walk(x, path ? `${path}.${k}` : k, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(res, "", 0);
}

// Files of a tar archive as texts: Map(path without its first `strip` folders -> text); only `wanted` paths,
// binaries as "". Reads ustar, pax (long paths) and GNU long names.
export function untar(tar, { strip = 0, wanted } = {}) {
  const out = new Map();
  const str = (b) => b.toString("utf8").replace(/\0[\s\S]*$/, "");
  let longName = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = body.toString("utf8").match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = str(body);
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = null;
    if (type !== "0" && type !== "7") continue; // regular files only
    const path = name.split("/").slice(strip).join("/");
    if (!path || (wanted && !wanted.has(path))) continue;
    const text = body.toString("utf8");
    out.set(path, text.includes("\u0000") ? "" : text);
  }
  return out;
}

// fn over items, n at a time, results in order.
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// Scope fields of a template from what was given: defaults applied, required ones checked (strict).
function cleanScope(t, scope, { strict = true } = {}) {
  const clean = {};
  for (const [name, field] of Object.entries(t.scope ?? {})) {
    const value = String(scope[name] ?? "").trim() || field.default;
    if (strict && field.required && !value) throw new Error(`${name} is required: ${field.description}`);
    if (value) clean[name] = value;
  }
  return clean;
}

// Problems with a recipe's shape, before anything runs.
function checkRecipe(r) {
  if (!r || typeof r !== "object") return ["recipe must be an object"];
  const out = [];
  if (!r.toolkit) out.push("toolkit is required (the app's slug, e.g. linear)");
  if (!r.name) out.push("name is required");
  if (r.parts && (!Array.isArray(r.parts) || !r.parts.length)) out.push("parts must be a non-empty array of { key, name, list, read? }");
  for (const p of partsOf(r)) {
    const at = r.parts ? `parts.${p.key ?? "?"}.` : "";
    if (r.parts && !p.key) out.push("every part needs a key (files, issues...)");
    if (!p.list?.tool) out.push(`${at}list.tool is required`);
    if (!p.list?.single && !p.list?.items) out.push(`${at}list.items is required: the path to the array of items in the response, e.g. data.issues`);
    if (!p.list?.single && !p.list?.id) out.push(`${at}list.id is required: the path to an item's id`);
    for (let e = p.list?.each, n = 0; e && n < 4; e = e.each, n++) {
      if (!e.tool || !e.items || !e.id) out.push(`${at}list.each needs tool, items and id (and label): the call that lists the containers`);
    }
    if (!p.read?.tool && !p.list?.text && !p.list?.single) out.push(`${at}read.tool (+ read.text) or list.text is required`);
    if (p.read?.tool && !p.read.text) out.push(`${at}read.text is required: the path to the text in the read response`);
    for (const x of p.exclude ?? []) {
      try {
        new RegExp(x);
      } catch {
        out.push(`${at}exclude: invalid regex ${x}`);
      }
    }
  }
  if (r.scope && typeof r.scope !== "object") out.push("scope must be an object of fields");
  return out;
}

function cleanFilter(f = {}) {
  const out = {};
  for (const k of ["include", "exclude"]) {
    if (!f[k]) continue;
    new RegExp(f[k]); // throws on an invalid one
    out[k] = String(f[k]);
  }
  if (Number(f.maxItems) > 0) out.maxItems = Math.min(Number(f.maxItems), LIMITS.maxItems);
  return out;
}

// Raw items for a test result: enough to see the paths, not the whole payload.
const clip = (v) => JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 200 ? `${x.slice(0, 200)}…` : Array.isArray(x) && x.length > 5 ? x.slice(0, 5) : x)).slice(0, 4000);

// What callers see of a source: no account internals. A sync that died with its process (no update for
// 10 minutes) shows as partial, so it can be continued.
const publicSource = ({ id, template, toolkit, title, scope, depth, filter, status, sync_started_at, created_at, synced_at, stats, last_run, watch, watch_error, schedule, recipe_of }) => ({
  recipe_of: recipe_of ?? null,
  every: schedule?.every ?? null,
  id,
  template,
  toolkit,
  title,
  scope,
  depth: depth ?? "full",
  filter: filter ?? {},
  status: status === "syncing" && Date.now() - new Date(sync_started_at).getTime() > 600_000 ? "partial" : status,
  created_at,
  synced_at: synced_at ?? null,
  stats,
  last_run: last_run ?? null,
  watching: (watch ?? []).map((w) => w.label),
  watch_error: watch_error ?? null,
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

// How to sync a call's result, found in a real response: the biggest list of objects, and in its items an id,
// a version and a title. No list: the whole response is one item (re-read every sync).
// path before sha: in a file tree the path is the file, the sha its version.
const ID = ["id", "uuid", "messageId", "message_id", "ts", "number", "key", "path", "sha", "gid", "name"];
const VERSION = ["updated_at", "updatedAt", "modifiedTime", "modified_time", "last_edited_time", "lastModified", "updated", "etag", "historyId", "edited.ts", "internalDate", "sha", "ts"];
const TITLE = ["subject", "title", "name", "summary", "full_name", "displayName", "display_name", "text", "snippet", "label", "email", "filename", "path"];
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

// Where the text is in a read response: the content of an object marked base64 (GitHub file contents), or else the
// longest string that is not a link. { text, encoding? } or null when there is no text.
export function inferText(response) {
  let best = null;
  let encoded = null;
  const walk = (v, path, depth) => {
    if (depth > 6 || v == null || typeof v !== "object" || encoded) return;
    const at = (k) => (path ? `${path}.${k}` : k);
    if (v.encoding === "base64" && typeof v.content === "string") {
      encoded = { text: at("content"), encoding: at("encoding") };
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string") {
        if (!/^https?:\/\/\S*$/.test(x) && (!best || x.length > best.length)) best = { path: at(k), length: x.length };
      } else if (!Array.isArray(x)) walk(x, at(k), depth + 1);
    }
  };
  walk(response, "", 0);
  return encoded ?? (best ? { text: best.path } : null);
}
