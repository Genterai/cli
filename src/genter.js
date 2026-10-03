import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import { createSources, inferList } from "./sync.js";

// Genter = Composio + recipes of past calls.
// A call record is { id, tool, args, created_at, summary, digest, memory }: memory is the recipe description,
// summary is a short retelling of the result (topics, names, ids to open it again). The raw result is never stored.
// Every successful call is saved as a recipe; the slow part (summary, embeddings, dedupe) runs after the result
// is returned, through `defer` (default: tracked, awaited by flush()). A call merged into an older recipe of the same
// call is kept as an alias of it, so every id execute returned stays valid.
// Records are encrypted before they reach the store, so the store only sees rows { id, remembered, blob }
// and needs: get(id), put(row), all() (remembered rows).
// knowledge (optional) stores sources, see sync.js; without it there are no sources.
// onSync(source, { reason }) (optional) is told about every sync run: manual, trigger, schedule or live.
// triggers: true only where Composio's webhook reaches this code (the hosted backend); the CLI can not receive events.
export function createGenter({ composioApiKey, openrouterApiKey, userId, secret, store, knowledge, triggers = false, defer, onSync, minScore = 0.25, strongScore = 0.45 }) {
  if (!secret) throw new Error("secret is required to encrypt stored calls");
  const composio = new Composio({ apiKey: composioApiKey });
  const { seal, open: decrypt } = cipher(`${secret}:${userId}`);
  // Decrypted records are cached by their blob (a new seal has a new random iv), so search does not
  // decrypt and parse every recipe on every call.
  const open = (blob) => {
    const key = `${userId}:${blob.slice(0, 40)}`;
    let record = decrypted.get(key);
    if (!record) {
      record = unpack(decrypt(blob));
      decrypted.set(key, record);
      if (decrypted.size > 20000) decrypted.delete(decrypted.keys().next().value);
    }
    return record;
  };
  const load = async (id, hops = 0) => {
    const row = await store.get(id);
    if (!row) throw new Error(`Unknown id: ${id}`);
    const record = open(row.blob);
    return record.alias && hops < 3 ? load(record.alias, hops + 1) : record;
  };
  const save = (record, remembered = Boolean(record.memory)) => store.put({ id: record.id, remembered, blob: seal(pack(record)) });
  const pending = new Set();
  const later = (task) => {
    const p = task.catch((e) => console.error("genter: saving a recipe failed:", e.message));
    if (defer) return defer(p);
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  // OpenRouter chat call. The fastest provider for the model by default (OPENROUTER_SORT=throughput|latency|price).
  async function chat(body, timeout = 30000) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { sort: process.env.OPENROUTER_SORT || "throughput" }, ...body }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status} ${await res.text()}`);
    return (await res.json()).choices[0].message.content?.trim() ?? "";
  }

  // A search in another language than English: the English version and the key terms in both languages.
  // Tool search (Composio) works in English, and keyword search in apps matches literal words, so data in English
  // is not found by Russian words and the other way round. Cached, and shared by concurrent callers.
  async function translate(query) {
    if (!openrouterApiKey || !/(?![\x00-\x7F])\p{L}/u.test(query)) return null;
    if (!translations.has(query)) {
      translations.set(
        query,
        chat(
          {
            model: process.env.QUERY_MODEL || process.env.SUMMARY_MODEL || "openai/gpt-oss-20b",
            reasoning: { effort: "low" },
            response_format: { type: "json_object" },
            messages: [
              {
                role: "user",
                content:
                  "A user searches their apps (email, chats, docs, issues) with this request. Translate it for searching. " +
                  'Reply with JSON only: {"en": "<the request in English>", "terms": ["<key search terms in the original language>", ' +
                  '"<the same terms in English, plus 1-2 close English synonyms>"]}. Keep names, emails, ids and quoted text as they are. ' +
                  `Terms are short phrases that would appear in the data, not the whole request.\n\n${query}`,
              },
            ],
          },
          6000,
        )
          .then((text) => {
            const out = JSON.parse(text);
            return { en: String(out.en ?? "").trim() || null, terms: (out.terms ?? []).map(String).filter(Boolean).slice(0, 10) };
          })
          .catch(() => null),
      );
      if (translations.size > 1000) translations.delete(translations.keys().next().value);
    }
    return translations.get(query);
  }

  // Embeddings via OpenRouter (OpenAI-compatible). Without a key, memory search is skipped.
  async function embed(text) {
    if (!openrouterApiKey) return null;
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small", input: text }),
    });
    if (!res.ok) throw new Error(`Embeddings failed: ${res.status} ${await res.text()}`);
    return (await res.json()).data[0].embedding;
  }

  // A connection alias from login -> its account id. Unknown aliases stay as they are (strict) or mean the default.
  async function accountId(account, { strict = true } = {}) {
    if (!account || account.startsWith("ca_")) return account || undefined;
    const { items } = await composio.connectedAccounts.list({ userIds: [userId], limit: 100 });
    return items.find((a) => a.alias === account)?.id ?? (strict ? account : undefined);
  }

  // Several texts at once, for source chunks.
  async function embedMany(input) {
    if (!openrouterApiKey) throw new Error("Sources need an OpenRouter key for embeddings (OPENROUTER_API_KEY)");
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small", input }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Embeddings failed: ${res.status} ${await res.text()}`);
    return (await res.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // Sources: an app's content synced as knowledge (sync.js). Tools run directly, they are not saved as recipes.
  const sources =
    knowledge &&
    createSources({
      run: async (tool, args, account) => {
        const id = await accountId(account, { strict: false });
        return composio.tools.execute(tool, { userId, arguments: args, ...(id && { connectedAccountId: id }), dangerouslySkipVersionCheck: true });
      },
      embedMany,
      onSync,
      triggers: triggers && {
        create: async (slug, config, account) => {
          const id = await accountId(account, { strict: false });
          return (await composio.triggers.create(userId, slug, { ...(id && { connectedAccountId: id }), triggerConfig: config })).triggerId;
        },
        disable: (id) => composio.triggers.disable(id),
        remove: (id) => composio.triggers.delete(id),
      },
      summarize: (title, text) =>
        chat({
          model: process.env.SUMMARY_MODEL || "openai/gpt-oss-20b",
          reasoning: { effort: "low" },
          messages: [
            {
              role: "user",
              content:
                `Summarize "${title}" in 2-4 sentences so it can be found later: what it is about, key names, terms and decisions. ` +
                `Write in the language of the text. No passwords, tokens or keys.\n\n${text.slice(0, 20000)}`,
            },
          ],
        }).catch(() => null),
      // Live sync recipes saved by the agent are records of kind "sync" in the recipe store.
      recipes: {
        get: async (id) => {
          const row = await store.get(id);
          const record = row && open(row.blob);
          return record?.kind === "sync" ? record.sync : (record?.live ?? null);
        },
        list: async () =>
          (await store.all())
            .map((row) => open(row.blob))
            .filter((r) => r.kind === "sync" && !r.alias && !r.memory?.disabled)
            .map((r) => ({ id: r.id, recipe: r.sync })),
      },
      seal: (value) => seal(value),
      open: (blob) => decrypt(blob),
      store: knowledge,
      namespace: userId,
    });

  // A short retelling of a result, so it can be found later by its topic. Skipped without an OpenRouter key.
  async function summarize(tool, data) {
    if (!openrouterApiKey) return null;
    return chat({
      model: process.env.SUMMARY_MODEL || "openai/gpt-oss-20b",
      reasoning: { effort: "low" },
      messages: [
        {
          role: "user",
          content:
            `Retell in 1-3 sentences what this ${tool} result contains, so it can be found later by topic: ` +
            "subjects, people, dates, and the ids or URLs needed to open it again. Write in English, but quote subjects, " +
            "titles and names exactly as they are. Only say what is in the data, do not guess. No passwords, tokens or keys." +
            `\n\n${JSON.stringify(data, decodeBase64).slice(0, 20000)}`,
        },
      ],
    }).catch(() => null); // a recipe without a summary is still useful
  }

  // Slow part of a call, after its result went back: summary, embedding, dedupe against the same call, recipe.
  async function remember(record, data, { description, short, tags }) {
    const sameCall = (await store.all())
      .map((row) => open(row.blob))
      .filter((r) => r.id !== record.id && !r.alias && r.tool === record.tool && JSON.stringify(r.args) === JSON.stringify(record.args));
    let summary = sameCall.find((r) => r.digest === record.digest && r.summaryEmbedding)?.summary;
    let summaryEmbedding;
    if (!summary) {
      summary = await summarize(record.tool, data);
      summaryEmbedding = summary ? await embed(summary).catch(() => undefined) : undefined;
    }
    // Same tool and args with the same result (identical, or a near-identical summary): refresh that recipe, keep this
    // id as its alias. A different result, e.g. a new latest email, is a recipe of its own.
    const similar = sameCall.find(
      (r) => r.digest === record.digest || (r.summaryEmbedding && summaryEmbedding && cosine(r.summaryEmbedding, summaryEmbedding) >= 0.9),
    );
    let target = record;
    if (similar) {
      target = { ...similar, created_at: record.created_at, digest: record.digest, ...(summaryEmbedding && { summary, summaryEmbedding }) };
      await save(target);
      if (record.id !== similar.id) await save({ id: record.id, alias: similar.id }, false);
    } else {
      target = { ...record, summary, summaryEmbedding };
      await save(target, false);
    }
    if (description) {
      await api.save_recipes({ recipes: [{ id: target.id, description, short, tags }] });
    } else if (!target.memory) {
      const info = await composio.tools.getRawComposioToolBySlug(record.tool).catch(() => ({}));
      await api.save_recipes({
        recipes: [{ id: target.id, description: autoRecipe(info, record.tool, record.args), tags: [info.toolkit?.slug].filter(Boolean), auto: true }],
      });
    }
    // How to keep this recipe live, decided now from the real result, so Live sync is one click later.
    if (sources && !target.live) await planLive(target.id, data).catch((e) => console.error("genter: live plan failed:", e.message));
    return summary;
  }

  const toolInfos = new Map();
  const toolInfo = (tool) => {
    if (!toolInfos.has(tool)) toolInfos.set(tool, composio.tools.getRawComposioToolBySlug(tool).catch(() => ({})));
    return toolInfos.get(tool);
  };
  const triggerTypes = new Map();
  const triggersOf = (toolkit) => {
    if (!triggerTypes.has(toolkit)) {
      triggerTypes.set(toolkit, composio.triggers.listTypes({ toolkits: [toolkit], limit: 100 }).then((l) => l.items ?? l).catch(() => []));
    }
    return triggerTypes.get(toolkit);
  };

  // A recipe's live sync: the same call re-run, its list found in the result (inferList), every item as Markdown;
  // updated by the triggers a model picks for it, or hourly when none fits.
  async function planLive(id, data) {
    const record = await load(id);
    if (record.kind === "sync") return;
    const info = await toolInfo(record.tool);
    const toolkit = info.toolkit?.slug ?? record.tool.split("_")[0].toLowerCase();
    const shape = inferList({ data });
    const name = titleOf(record.memory?.description) || info.name || record.tool;
    const triggers = await pickTriggers({ toolkit, tool: record.tool, args: record.args, description: record.memory?.description }).catch(() => []);
    record.live = {
      name,
      toolkit,
      description: `Keeps "${name}" up to date`,
      title: name,
      scope: {},
      // Items that never change (messages) carry no version: the list is a window of the latest, keep what leaves it.
      list: { tool: record.tool, args: record.args, ...shape, ...(shape.version && shape.version === shape.id && { append: true }) },
      triggers,
      every: triggers.length ? null : 60,
    };
    await save(record);
    return record.live;
  }

  // Triggers that fire when this call's result may change, chosen by a model, with config it could fill.
  async function pickTriggers({ toolkit, tool, args, description }) {
    const types = await triggersOf(toolkit);
    if (!types.length || !openrouterApiKey) return [];
    const options = types.map((t) => ({
      slug: t.slug,
      description: String(t.description ?? "").split("\n")[0].slice(0, 140),
      required: t.config?.required ?? [],
      config: Object.keys(t.config?.properties ?? {}),
    }));
    const text = await chat(
      {
        model: process.env.BUILDER_MODEL || "openai/gpt-6-luna",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `A recipe runs ${tool} with args ${JSON.stringify(args)}` +
              `${description ? ` (${String(description).slice(0, 400)})` : ""}. ` +
              "Which of these triggers fire when its result may change (a new or updated item it would return)? " +
              'Reply with JSON only: {"triggers": [{"slug": "...", "config": {...}, "label": "on every new email"}]}. ' +
              "Fill every required config field from the args; skip a trigger you can not fill. Usually one or two; none fits: [].\n\n" +
              JSON.stringify(options),
          },
        ],
      },
      20000,
    );
    const picked = JSON.parse(text).triggers ?? [];
    return picked
      .filter((t) => {
        const type = types.find((x) => x.slug === t.slug);
        // A config the model left as a placeholder ({{container}}) can not be filled for one trigger.
        return type && !JSON.stringify(t.config ?? {}).includes("{{") && (type.config?.required ?? []).every((k) => t.config?.[k] != null && t.config[k] !== "");
      })
      .slice(0, 3)
      .map((t) => ({ slug: t.slug, config: t.config ?? {}, label: String(t.label || t.slug).slice(0, 60) }));
  }

  const api = {
    // Returns a Composio link the user opens to connect an app (gmail, github, ...).
    // callback_url: where Composio sends the user afterwards (with ?status=success|failed).
    // An app can be connected several times (e.g. work and personal gmail); alias names the connection.
    async register_tool({ toolkit, callback_url, alias }) {
      const configs = await composio.authConfigs.list({ toolkit });
      const authConfigId =
        configs.items[0]?.id ??
        (await composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name: `${toolkit} auth config` })).id;
      const request = await composio.connectedAccounts.link(userId, authConfigId, {
        allowMultiple: true,
        ...(callback_url && { callbackUrl: callback_url }),
        ...(alias && { alias }),
      });
      return { toolkit, connect_url: request.redirectUrl, connection_id: request.id };
    },

    // Who am I and which apps are connected. `account` is what execute takes when an app has several connections.
    async login() {
      const { items } = await composio.connectedAccounts.list({ userIds: [userId], limit: 100 });
      return {
        user_id: userId,
        connected: items.map((a) => ({ toolkit: a.toolkit.slug, account: a.id, alias: a.alias ?? undefined, status: a.status })),
      };
    },

    // The English version and bilingual key terms of a non-English query ({ en, terms }), or null.
    translate,

    // Memory first (ready-made calls with args), plain Composio search as fallback.
    // A non-English query is matched in its language and in English: recipes and summaries are mostly English.
    // `toolkits`: apps the query names (e.g. connected Google Tasks); their tools come first, because a
    // search over all of Composio often returns other apps' tools for a generic "list my tasks".
    async search({ query, limit = 5, toolkits = [] }) {
      const english = await translate(query);
      const vector = await embed(english?.en ? `${query}\n${english.en}` : query).catch(() => null);
      const memories = vector
        ? (await store.all())
            .map((row) => open(row.blob))
            .filter((r) => r.memory?.embedding && !r.alias && !r.memory.disabled) // a disabled recipe is never offered
            // Best of: how the recipe is described, and what its result was about.
            .map((r) => ({ r, score: Math.max(...[r.memory.embedding, r.summaryEmbedding].filter(Boolean).map((e) => cosine(vector, e))) }))
            .filter(({ score }) => score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ r, score }) => ({
              id: r.id,
              tool: r.tool,
              args: r.args,
              tags: r.memory.tags,
              description: r.memory.description,
              short: r.memory.short,
              ...(r.kind === "sync" && { kind: "sync", toolkit: r.sync.toolkit, scope: r.sync.scope }),
              live: Boolean(r.live || r.kind === "sync"),
              summary: r.summary,
              when: r.created_at,
              status: r.memory.status,
              score: Number(score.toFixed(2)),
            }))
        : [];
      if (memories.some((m) => m.status === "valid" && m.score >= strongScore)) return memories;

      const search = english?.en ?? query;
      const [own, all] = await Promise.all([
        toolkits.length ? composio.tools.getRawComposioTools({ toolkits, search, limit }).catch(() => []) : [],
        composio.tools.getRawComposioTools({ search, limit }),
      ]);
      const tools = [...own, ...all.filter((t) => !own.some((o) => o.slug === t.slug))].slice(0, limit + own.length);
      const found = tools.map((t) => ({
        id: null,
        tool: t.slug,
        args: t.inputParameters, // JSON schema of the arguments
        tags: [t.toolkit?.slug, ...(t.tags ?? [])].filter(Boolean),
        description: t.description,
        status: "new",
      }));
      return [...memories, ...found];
    },

    // Run a tool. Pass `id` to repeat a saved recipe (args are merged on top).
    // `account` picks a connection (from login) when an app is connected several times.
    // Every successful call becomes a recipe: with the agent's description if given, otherwise Composio's.
    async execute({ id, tool, args = {}, account, description, short, tags }) {
      const previous = id && (await load(id));
      if (previous?.kind === "sync") throw new Error(`${id} is a live sync recipe: add it as a source (add_source) instead of executing it`);
      if (previous) {
        tool ??= previous.tool;
        args = { ...previous.args, ...args };
      }
      if (!tool) throw new Error("Pass `tool` or `id`");
      account = await accountId(account); // an alias from login
      const result = await composio.tools.execute(tool, {
        userId,
        arguments: args,
        ...(account && { connectedAccountId: account }),
        dangerouslySkipVersionCheck: true,
      });
      const outdated = previous?.memory && {
        hint: `If this result does not match the saved description, save recipe ${id} with status "outdated" and say what changed.`,
      };
      if (!result.successful) return { result, ...outdated }; // failed calls are not recipes

      // The result goes back now; summary, embedding and the recipe are saved after (see remember).
      // Repeating a recipe with its own args answers with its id; a new call gets an id of its own right away.
      const digest = createHash("sha256").update(JSON.stringify(result.data)).digest("hex");
      const created_at = new Date().toISOString();
      const repeat = previous && JSON.stringify(previous.args) === JSON.stringify(args);
      const record = { id: repeat ? previous.id : randomUUID(), tool, args, created_at, digest };
      if (repeat && previous.digest === digest) {
        later(save({ ...previous, created_at }));
        return { id: record.id, result, summary: previous.summary, ...outdated };
      }
      if (repeat) record.id = randomUUID(); // a new result of a known call: a new recipe, merged later if it is the same
      await save(record, false);
      const summary = remember(record, result.data, { description, short, tags });
      later(summary);
      return {
        id: record.id,
        result,
        summary: null, // being written; `pending` resolves to it
        pending: summary.catch(() => null),
        ...outdated,
        ...(!description && {
          note:
            "Saved as a recipe with Composio's generic description. Optional: improve it with save_recipes " +
            "(the user's intent in plain words, what it returns, pitfalls, tags in English and Russian).",
        }),
      };
    },

    // Sources: templates(), choices({template, account?}), list(), get(id), create({template, scope, depth?, account?}),
    // sync({id, budgetMs?}), watch({id, on?}), onTrigger({triggerId}), remove({id}).
    sources,

    // Triggers that fire when a call's result may change, picked by a model: [{ slug, config, label }].
    pick_triggers: (args) => pickTriggers(args).catch(() => []),

    // The tools of an app that read, compact, for planning what can be synced: [{ tool, description, args }].
    async app_tools({ toolkit }) {
      // GitHub alone has ~900 tools: a lower cap drops its repos, issues and pull requests.
      const tools = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 2000 });
      return tools
        .filter((t) => readsOnly(t.slug, t.tags))
        .map((t) => ({
          tool: t.slug,
          description: String(t.description ?? "").split("\n")[0].slice(0, 140),
          args: Object.entries(t.inputParameters?.properties ?? {})
            .slice(0, 12)
            .map(([k, v]) => `${k}${(t.inputParameters?.required ?? []).includes(k) ? "" : "?"}:${v.type ?? "any"}`)
            .join(", "),
        }));
    },

    // Live sync of any recipe in one call: its plan (made when it was saved, or now), a source, a first sync, then
    // its triggers, or an hourly schedule when there are none (or they can not be turned on here).
    // once: just sync it now, without triggers or a schedule.
    async live_sync({ id, budgetMs = 60000, account, once = false }) {
      if (!sources) throw new Error("Sources are not available here");
      let record = await load(id);
      if (record.kind !== "sync" && !record.live) {
        const res = await composio.tools.execute(record.tool, { userId, arguments: record.args, ...(account && { connectedAccountId: await accountId(account) }), dangerouslySkipVersionCheck: true });
        if (!res.successful) throw new Error(`${record.tool}: ${JSON.stringify(res.error).slice(0, 300)}`);
        await planLive(record.id, res.data);
        record = await load(record.id);
      }
      const plan = record.kind === "sync" ? record.sync : record.live;
      const source = await sources.create({ template: record.id, scope: {}, account: account ?? plan.account, recipe_of: record.id });
      const synced = await sources.sync({ id: source.id, budgetMs, reason: once ? "manual" : "live" });
      if (once) return synced;
      if (plan.triggers?.length) {
        const watched = await sources.watch({ id: source.id }).catch((e) => ({ watching: [], watch_error: e.message }));
        if (watched.watching?.length) return watched;
      }
      if (synced.status === "failed") return synced;
      return sources.schedule({ id: source.id, every: plan.every ?? 60 });
    },

    // Saves a live sync recipe (see sync.js) after a test on real data passes; with id, replaces that recipe.
    // It is found by search like any recipe and used with sources.create({ template: id }).
    async save_live_sync({ id, recipe, description, short, tags = [], scope = {}, account }) {
      if (!sources) throw new Error("Sources are not available here");
      if (!description) throw new Error("description is required: what it syncs, in plain words");
      const test = await sources.test({ recipe, scope, account });
      // Triggers must exist and get their required config, or watching the source fails later.
      for (const t of recipe.triggers ?? []) {
        for (let cur = t; cur; cur = cur.fallback) {
          const type = await composio.triggers.getType(cur.slug).catch(() => null);
          if (!type) test.problems.push(`trigger ${cur.slug} does not exist (list_triggers)`);
          else {
            const missing = (type.config?.required ?? []).filter((k) => cur.config?.[k] == null);
            if (missing.length) test.problems.push(`trigger ${cur.slug} needs config ${missing.join(", ")}`);
          }
        }
      }
      if (test.problems?.length) test.ok = false;
      if (!test.ok) return { saved: false, test };
      if (id) {
        const old = await load(id);
        if (old.kind !== "sync") throw new Error(`${id} is not a live sync recipe`);
      }
      const record = { id: id ?? randomUUID(), kind: "sync", tool: recipe.list.tool, args: {}, sync: recipe, created_at: new Date().toISOString() };
      await save(record, false);
      await api.save_recipes({ recipes: [{ id: record.id, description, short, tags: [...new Set([recipe.toolkit, "sync", "синхронизация", ...tags])] }] });
      return { saved: true, id: record.id, test };
    },

    // Composio triggers of an app, for a live sync recipe's triggers: [{ slug, description, config, required, payload }].
    async trigger_types({ toolkit }) {
      const list = await composio.triggers.listTypes({ toolkits: [toolkit], limit: 100 });
      return (list.items ?? list).map((t) => ({
        slug: t.slug,
        description: String(t.description ?? "").split("\n")[0].slice(0, 160),
        config: Object.fromEntries(Object.entries(t.config?.properties ?? {}).map(([k, v]) => [k, `${v.type ?? "any"} ${String(v.description ?? "").slice(0, 80)}`])),
        required: t.config?.required ?? [],
        payload: Object.keys(t.payload?.properties ?? {}),
      }));
    },

    // Chunks of synced sources closest to a question: [{ source, source_title, title, url, text, score }].
    async knowledge({ query, limit = 6, source }) {
      if (!sources) return [];
      const english = await translate(query);
      const vector = await embed(english?.en ? `${query}\n${english.en}` : query).catch(() => null);
      return sources.search({ vector, limit, source });
    },

    // Waits for recipes still being saved (the CLI calls it before exiting).
    async flush() {
      await Promise.all([...pending]);
    },

    // Full argument schema of a tool, for the agent.
    async schema(tool) {
      const t = await composio.tools.getRawComposioToolBySlug(tool);
      return { tool: t.slug, description: t.description, args: t.inputParameters };
    },

    // Save reusable recipes for calls: each description is embedded for search.
    // `short` is a one-line description for lists and cards; the Markdown description is the full one.
    // Use status "outdated" when a saved recipe no longer does what its description says.
    async save_recipes({ recipes }) {
      return Promise.all(
        recipes.map(async ({ id, description, short, tags = [], status = "valid", auto }) => {
          const record = await load(id); // an alias resolves to the recipe it was merged into
          const created_at = new Date().toISOString();
          const embedding = await embed(
            `${description}\nresult: ${record.summary ?? ""}\ntags: ${tags.join(", ")}\ntool: ${record.tool}\nargs: ${JSON.stringify(record.args)}`,
          );
          const { disabled } = record.memory ?? {};
          await save({ ...record, memory: { created_at, tags, description, ...(short && { short }), status, embedding, ...(auto && { auto }), ...(disabled && { disabled }) } });
          return { id: record.id, created_at, tags, description, short, status };
        }),
      );
    },

    // Turn a recipe off (search and the agent skip it, it stays saved) or back on. disabled holds when it was turned off.
    async disable_recipe({ id, disabled = true }) {
      const record = await load(id);
      if (!record?.memory) throw new Error(`No recipe ${id}`);
      const { disabled: _, ...memory } = record.memory;
      await save({ ...record, memory: disabled ? { ...memory, disabled: new Date().toISOString() } : memory });
      return { id: record.id, disabled: Boolean(disabled) };
    },
  };
  return api;
}

const decrypted = new Map(); // "<user>:<blob prefix>" -> record, shared by every genter in the process
const translations = new Map(); // query -> Promise<{ en, terms } | null>

// Embeddings are stored as base64 float32 (8 KB instead of ~30 KB of JSON numbers each); older records keep arrays.
const VECTORS = ["summaryEmbedding"];
function pack(record) {
  const out = { ...record };
  for (const key of VECTORS) if (out[key]) out[key] = toB64(out[key]);
  if (out.memory?.embedding) out.memory = { ...out.memory, embedding: toB64(out.memory.embedding) };
  return out;
}
function unpack(record) {
  for (const key of VECTORS) if (typeof record[key] === "string") record[key] = fromB64(record[key]);
  if (typeof record.memory?.embedding === "string") record.memory.embedding = fromB64(record.memory.embedding);
  return record;
}
const toB64 = (v) => (typeof v === "string" ? v : Buffer.from(Float32Array.from(v).buffer).toString("base64"));
const fromB64 = (s) => {
  const b = Buffer.from(s, "base64"); // may sit unaligned in Node's pool: copy before viewing as floats
  return new Float32Array(Uint8Array.from(b).buffer);
};

// A tool that only reads, by Composio's hint or the verb in its slug.
function readsOnly(slug, tags = []) {
  if (tags.includes("readOnlyHint")) return true;
  const s = slug.toUpperCase();
  if (/_(SEND|CREATE|DELETE|REMOVE|UPDATE|PATCH|POST|REPLY|FORWARD|MOVE|ARCHIVE|TRASH|ADD|INSERT|UPLOAD|SET|INVITE|MERGE|CLOSE|PUBLISH|SHARE|EXECUTE|RUN|START|STOP|CANCEL|WATCH|PIN|UNPIN|FOLLOW|UNFOLLOW|MODIFY|CLEAR|BATCH_UPDATE|IMPORT|COPY)(_|$)/.test(s)) return false;
  return /_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|HISTORY|EXPORT|DOWNLOAD)(_|$)/.test(s);
}

// "### Fetch unread emails\n..." -> "Fetch unread emails".
const titleOf = (md) => (String(md ?? "").split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").replace(/[`*_]/g, "").trim().slice(0, 80);

// A recipe in Markdown from Composio's generic tool description.
function autoRecipe(info, tool, args) {
  const keys = Object.keys(args).join(", ");
  return `### ${info?.name || tool}\n\n\`${tool}\` · args: \`{${keys}}\`\n\n${(info?.description ?? "").trim()}`;
}

// AES-256-GCM. Blob = iv (12 bytes) + auth tag (16 bytes) + ciphertext, base64.
export function cipher(secret) {
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(value) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    open(blob) {
      const b = Buffer.from(blob, "base64");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
    },
  };
}

// APIs like GitHub return file contents as base64; decode them so the summary can read them.
function decodeBase64(key, value) {
  if (value?.encoding === "base64" && typeof value.content === "string") {
    return { ...value, content: Buffer.from(value.content, "base64").toString("utf8") };
  }
  return value;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}
