import { createHash } from "node:crypto";
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
// list.text "@item": the item itself as Markdown (no read call). list.single: the whole response is one item.
// list.append: keep items that left the list (streams: mail, chat) instead of removing them.
// Every call recipe can be synced: inferList finds the list, id, version and title in a real response.
// Updates: the recipe's triggers, or a schedule ({ every: minutes }); store rows carry next_sync_at for the scheduler.

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

const LIMITS = { maxItems: 3000, maxPages: 100, maxChunks: 80, chunkSize: 1600, overlap: 200, readers: 6, embedBatch: 64 };

// run(tool, args, account) -> Composio result; embedMany(texts) -> vectors; seal/open: encryption; store: see below.
// store: getSource(id), putSource({id, blob}), deleteSource(id), sources() -> [{id, blob}],
//        items(sourceId) -> [{source_id, key, blob}], putItems(rows), deleteItems(sourceId, keys), allItems() -> rows
// namespace: the user or workspace, so ids and running syncs never mix between them.
export const DEPTHS = ["titles", "summary", "full"];

// triggers (optional): create(slug, config, account) -> trigger id (re-enables the same one if it exists), disable(id), remove(id).
// recipes (optional): saved live sync recipes, get(id) -> recipe | null, list() -> [{ id, recipe }].
export function createSources({ run, embedMany, summarize, triggers, recipes, seal, open, store, namespace = "" }) {
  const loadSource = async (id) => {
    const row = await store.getSource(id);
    if (!row) throw new Error(`Unknown source: ${id}`);
    return open(row.blob);
  };
  const saveSource = (source) => store.putSource({ id: source.id, blob: seal(source), next_sync_at: source.schedule?.next ?? null });
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

  // Lists every item of a source, page by page. raw (optional) collects the first raw items, for a test.
  async function list(source, template, { pages = LIMITS.maxPages, raw } = {}) {
    const role = template.list;
    const out = [];
    let page;
    for (let n = 0; n < pages; n++) {
      // nextPage: numbered pages (1, 2, ...) until one comes back empty; otherwise the cursor from list.next.
      if (role.nextPage) page = n + 1;
      const res = await run(role.tool, fill(role.args, { ...source.scope, page }), source.account);
      if (res?.successful === false) throw new Error(`${role.tool}: ${errorText(res.error)}`);
      if (role.single) {
        // The whole response is the item, versioned by its content.
        const data = res?.data ?? res;
        out.push({ id: "all", version: createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16), title: source.title, text: jsonToMarkdown(data) });
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
        const ctx = { ...source.scope, item: raw };
        out.push({
          id: String(id),
          version: String(pick(raw, role.version) ?? ""),
          title: String(pick(raw, role.title) ?? id),
          url: role.url?.includes("{{") ? fill(role.url, ctx) : role.url ? pick(raw, role.url) : undefined,
          size: role.size ? Number(pick(raw, role.size)) || 0 : undefined,
          text: role.text === "@item" ? jsonToMarkdown(raw) : role.text ? pick(raw, role.text) : undefined,
          parent: role.parent ? pick(raw, role.parent) : undefined,
        });
        if (out.length > LIMITS.maxItems) {
          throw new Error(`More than ${LIMITS.maxItems} items in ${source.title}. Narrow the source down (a folder, a query).`);
        }
      }
      if (role.nextPage) {
        if (!found.length) break;
        continue;
      }
      const next = role.next && pick(res, role.next);
      if (!next) break;
      page = next;
    }
    const prefix = template.prefix ? String(fill(template.prefix, source.scope) ?? "").replace(/^\/+/, "") : "";
    // A root: only it and the items under it, by the parent links in the list itself.
    const root = template.root ? fill(template.root, source.scope) : null;
    const parents = new Map(out.map((i) => [i.id, i.parent]));
    const under = (id) => {
      for (let n = 0, cur = id; cur && n < 30; n++, cur = parents.get(cur)) if (cur === root) return true;
      return false;
    };
    const exclude = (template.exclude ?? []).map((x) => new RegExp(x, "i"));
    const filter = source.filter ?? {};
    const include = filter.include ? new RegExp(filter.include, "i") : null;
    const skip = filter.exclude ? new RegExp(filter.exclude, "i") : null;
    const kept = out.filter(
      (i) =>
        (!root || under(i.id)) &&
        i.id.startsWith(prefix) &&
        !exclude.some((re) => re.test(i.id)) &&
        !(template.maxSize && i.size > template.maxSize) &&
        (!include || include.test(`${i.id} ${i.title}`)) &&
        !(skip && skip.test(`${i.id} ${i.title}`)),
    );
    return filter.maxItems ? kept.slice(0, filter.maxItems) : kept;
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
    const template = await templateOf(source);
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
      const gone = template.list.append ? [] : [...known.values()].filter((k) => !seen.has(k.id));
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
    // A partial sync continues soon; a done or failed one waits for its next turn.
    if (source.schedule) source.schedule.next = new Date(Date.now() + (source.status === "partial" ? 60_000 : source.schedule.every * 60_000)).toISOString();
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
    // Live sync recipes: built in, then saved ones. { template, toolkit, name, description, scope, choices, triggers, builtin }.
    async templates() {
      const saved = recipes ? await recipes.list() : [];
      return [...Object.entries(BUILTIN).map(([id, recipe]) => ({ id, recipe, builtin: true })), ...saved].map(({ id, recipe, builtin }) => ({
        template: id,
        toolkit: recipe.toolkit,
        name: recipe.name,
        description: recipe.description ?? "",
        scope: recipe.scope ?? {},
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
        const items = await list(source, recipe, { pages: 1, raw });
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
    async sync({ id, budgetMs, again = false }) {
      const key = `${namespace}:${id}`;
      if (running.has(key)) {
        if (again) rerun.add(key);
        return running.get(key);
      }
      const job = (async () => {
        let out;
        do {
          rerun.delete(key);
          const source = await loadSource(id);
          source.status = "syncing";
          source.sync_started_at = new Date().toISOString();
          await saveSource(source);
          out = await syncNow(source, { budgetMs });
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
              made.push({ id: await triggers.create(cur.slug, fill(cur.config, source.scope), source.account), slug: cur.slug, label: cur.label });
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
      return Promise.all(hit.map((src) => api.sync({ id: src.id, budgetMs, again: true })));
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
const rerun = new Set(); // keys to sync once more when their running sync ends

// where: every path must equal its value; skip: none may.
const matches = (raw, role) =>
  (!role.where || Object.entries(role.where).every(([p, v]) => pick(raw, p) === v)) &&
  !(role.skip && Object.entries(role.skip).some(([p, v]) => pick(raw, p) === v));

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
  if (!r.list?.tool) out.push("list.tool is required");
  if (!r.list?.single && !r.list?.items) out.push("list.items is required: the path to the array of items in the response, e.g. data.issues");
  if (!r.list?.single && !r.list?.id) out.push("list.id is required: the path to an item's id");
  if (!r.read?.tool && !r.list?.text) out.push("read.tool (+ read.text) or list.text is required");
  if (r.read?.tool && !r.read.text) out.push("read.text is required: the path to the text in the read response");
  if (r.scope && typeof r.scope !== "object") out.push("scope must be an object of fields");
  for (const x of r.exclude ?? []) {
    try {
      new RegExp(x);
    } catch {
      out.push(`exclude: invalid regex ${x}`);
    }
  }
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
const ID = ["id", "uuid", "messageId", "message_id", "ts", "number", "key", "sha", "gid", "path", "name"];
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
  const url = LINK.find((k) => best.sample.every((x) => /^https?:\/\//.test(String(pick(x, k) ?? ""))));
  return { items: best.path, id, ...(version && { version }), title, ...(url && { url }), text: "@item" };
}
