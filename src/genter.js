import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import { readyFor } from "./ready.js";
import { createSources, fill, inferList } from "./sync.js";

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

  // Every tool of these apps, cached per app for an hour (Google Tasks has 18, GitHub ~900).
  function toolsOf(toolkits) {
    return Promise.all(
      toolkits.map((toolkit) => {
        const hit = appTools.get(toolkit);
        if (hit && Date.now() - hit.at < 3600_000) return hit.list;
        const list = composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 2000 });
        appTools.set(toolkit, { at: Date.now(), list });
        list.catch(() => appTools.delete(toolkit));
        return list;
      }),
    ).then((lists) => lists.flat());
  }

  // An app's tools ranked for a query: by meaning (each tool's description embedded once per app and cached),
  // and by the query's words in the slug. Without vectors, by the words alone.
  async function appToolsFor(toolkits, query, vector, limit) {
    const tools = await toolsOf(toolkits);
    const vectors = vector && (await Promise.all(toolkits.map(toolVectors)).catch(() => null));
    const bySlug = new Map(vectors ? vectors.flat() : []);
    return rankTools(tools, query, limit, vectors ? tools.map((t) => (bySlug.has(t.slug) ? cosine(vector, bySlug.get(t.slug)) : 0)) : null);
  }

  // [slug, embedding] of every tool of an app; one batched call per 300 tools, cached with the tools.
  function toolVectors(toolkit) {
    const hit = appVectors.get(toolkit);
    if (hit && Date.now() - hit.at < 3600_000) return hit.list;
    const list = toolsOf([toolkit]).then(async (tools) => {
      const text = (t) => `${t.slug.toLowerCase().replace(/_/g, " ")}: ${String(t.description ?? "").slice(0, 200)}`;
      const chunks = [];
      for (let i = 0; i < tools.length; i += 300) chunks.push(tools.slice(i, i + 300));
      const vectors = (await Promise.all(chunks.map((c) => embedMany(c.map(text))))).flat();
      return tools.map((t, i) => [t.slug, vectors[i]]);
    });
    appVectors.set(toolkit, { at: Date.now(), list });
    list.catch(() => appVectors.delete(toolkit));
    return list;
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
      // A sync recipe's last result is what its sync keeps: its summary says so, for cards and search.
      onSync: async (source, info) => {
        if (source.recipe_of && source.status !== "failed") await noteSynced(source).catch((e) => console.error("genter: recipe summary failed:", e.message));
        if (onSync) await onSync(source, info);
      },
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

  // What a result is and what it holds, from one model call: { title, about, summary }. title names the result of
  // this exact call ("Open pull requests of Genterai/genter-cli"): a recipe is named by it and has no parameters.
  // summary retells the content so it is found later by topic. Skipped without an OpenRouter key.
  async function describe(tool, args, data) {
    if (!openrouterApiKey) return null;
    const text = await chat({
      model: process.env.SUMMARY_MODEL || "openai/gpt-oss-20b",
      reasoning: { effort: "low" },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content:
            `A call of ${tool} with args ${JSON.stringify(args).slice(0, 600)} returned the data below. ` +
            'Reply with JSON only: {"title": "...", "about": "...", "summary": "..."}.\n' +
            'title: what this result is, as a name of up to 8 words for these exact args, in English, e.g. "Open pull requests of Genterai/genter-cli", "Unread emails from today".\n' +
            "about: 1-2 sentences: what the result is (which items, which filters) and what each item has, so someone knows what they get without running it.\n" +
            "summary: 1-3 sentences retelling what it contains, so it can be found later by topic: subjects, people, dates, and the ids or URLs " +
            "needed to open it again. Write in English, but quote subjects, titles and names exactly as they are.\n" +
            "Only say what is in the data, do not guess. No passwords, tokens or keys." +
            `\n\n${JSON.stringify(data, decodeBase64).slice(0, 20000)}`,
        },
      ],
    }).catch(() => null); // a recipe without a summary is still useful
    if (!text) return null;
    try {
      const out = JSON.parse(text);
      const clean = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
      return { title: clean(out.title, 100)?.replace(/^#+\s*/, ""), about: clean(out.about, 600), summary: clean(out.summary, 1200) };
    } catch {
      return { summary: text.slice(0, 1200) };
    }
  }

  // Slow part of a call, after its result went back: summary, embedding, dedupe against the same call, recipe.
  async function remember(record, data, { description, short, tags }) {
    const sameCall = (await store.all())
      .map((row) => open(row.blob))
      .filter((r) => r.id !== record.id && !r.alias && r.tool === record.tool && JSON.stringify(r.args) === JSON.stringify(record.args));
    let summary = sameCall.find((r) => r.digest === record.digest && r.summaryEmbedding)?.summary;
    let summaryEmbedding;
    let named = null;
    if (!summary) {
      named = await describe(record.tool, record.args, data);
      summary = named?.summary ?? null;
      summaryEmbedding = summary ? await embed(summary).catch(() => undefined) : undefined;
    }
    // Same tool and args with the same result (identical, or a near-identical summary): refresh that recipe, keep this
    // id as its alias. A different result, e.g. a new latest email, is a recipe of its own.
    // A named recipe's own first run (a ready read) stays itself, never an alias of an older call.
    const similar = record.memory
      ? null
      : sameCall.find((r) => r.digest === record.digest || (r.summaryEmbedding && summaryEmbedding && cosine(r.summaryEmbedding, summaryEmbedding) >= 0.9));
    let target = record;
    if (similar) {
      target = { ...similar, created_at: record.created_at, digest: record.digest, ...(summaryEmbedding && { summary, summaryEmbedding }) };
      await save(target);
      if (record.id !== similar.id) await save({ id: record.id, alias: similar.id }, false);
    } else {
      target = { ...record, summary, summaryEmbedding };
      await save(target, Boolean(target.memory));
    }
    if (description) {
      await api.save_recipes({ recipes: [{ id: target.id, description, short, tags }] });
    } else if (!target.memory) {
      // Named by its result: what this exact call returns, no parameters to fill in.
      const info = await toolInfo(record.tool);
      const tags = [info.toolkit?.slug].filter(Boolean);
      await api.save_recipes({
        recipes: [
          named?.title
            ? { id: target.id, description: resultRecipe(named, record.tool), short: named.title, tags, auto: true }
            : { id: target.id, description: autoRecipe(info, record.tool, record.args), tags, auto: true },
        ],
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

  // What a sync recipe keeps, as its result summary: "412 items kept: 380 files, 31 issues and pull requests, about".
  async function noteSynced(source) {
    const record = await load(source.recipe_of);
    const plan = record.kind === "sync" ? record.sync : record.live;
    if (!plan) return;
    const parts = plan.parts?.length && source.stats?.parts
      ? `: ${plan.parts.map((p) => `${source.stats.parts[p.key] ?? 0} ${String(p.name ?? p.key).toLowerCase()}`).join(", ")}`
      : "";
    const summary = `${source.stats?.items ?? 0} items kept as embeddings${parts}. Synced ${String(source.synced_at ?? source.last_run?.at ?? "").slice(0, 16).replace("T", " ")}${source.status === "partial" ? ", still syncing" : ""}.`;
    if (record.summary === summary) return;
    await save({ ...record, summary });
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
    // `apps`: the connected toolkits. Those the query names (in its words or in English: "гугл таски" ->
    // Google Tasks) give their tools first, because a search over all of Composio returns other apps' tools.
    // `toolkits`: apps to search in anyway (the agent passes those its task named).
    async search({ query, limit = 5, apps = [], toolkits: also = [] }) {
      const english = await translate(query);
      const toolkits = [...new Set([...also, ...namedApps(`${query} ${english?.en ?? ""}`, apps)])];
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
      // A sync recipe's result is its synced source: which one, and how much it keeps.
      if (sources && memories.some((m) => m.kind === "sync" || m.live)) {
        const kept = new Map((await sources.list().catch(() => [])).filter((s) => s.recipe_of).map((s) => [s.recipe_of, s]));
        for (const m of memories) {
          const s = kept.get(m.id);
          if (s) m.source = { id: s.id, status: s.status, items: s.stats?.items ?? 0, synced_at: s.synced_at, watching: s.watching, every: s.every };
        }
      }
      if (memories.some((m) => m.status === "valid" && m.score >= strongScore)) return memories;

      const search = english?.en ?? query;
      const [own, all] = await Promise.all([
        toolkits.length ? appToolsFor(toolkits, `${query}\n${english?.en ?? ""}`, vector, Math.max(limit, 8)).catch(() => []) : [],
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
    // remember: false runs it without saving it (an inner step, e.g. reading and committing a file for an edit).
    async execute({ id, tool, args = {}, account, description, short, tags, remember = true }) {
      const previous = id && (await load(id));
      if (previous?.kind === "sync") throw new Error(`${id} is a sync recipe: its result is kept as embeddings (search_knowledge); live_sync or Run now refreshes it`);
      if (previous) {
        tool ??= previous.tool;
        args = { ...previous.args, ...args };
        account ??= previous.memory?.account; // a ready read runs on the account it was made for
      }
      if (!tool) throw new Error("Pass `tool` or `id`");
      account = await accountId(account); // an alias from login
      // Dates stay placeholders in the recipe ({{today}}, {{ago.7d}}) and are filled for this run.
      const result = await composio.tools.execute(tool, {
        userId,
        arguments: withDates(args),
        ...(account && { connectedAccountId: account }),
        dangerouslySkipVersionCheck: true,
      });
      const outdated = previous?.memory && {
        hint: `If this result does not match the saved description, save recipe ${id} with status "outdated" and say what changed.`,
      };
      if (!result.successful) return { result, ...outdated }; // failed calls are not recipes
      if (!remember) return { result };

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
      // A recipe made before it ever ran (a ready read): this first result is its own, kept in place.
      const first = repeat && !previous.digest && !previous.alias;
      if (first) Object.assign(record, { ...previous, created_at, digest });
      else if (repeat) record.id = randomUUID(); // a new result of a known call: a new recipe, merged later if it is the same
      await save(record, Boolean(record.memory));
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

    // Every tool of an app as Composio describes it ({ slug, description, inputParameters, tags }), cached for an hour:
    // which of them write at a reference (refs.js writeHints).
    catalog: ({ toolkit }) => toolsOf([toolkit]),

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

    // Apps with ready recipes (made at once when an account is connected, no model): [{ toolkit, name }].
    ready_apps: () => ["github", "gmail", "googlecalendar", "googletasks", "notion"].map((toolkit) => ({ toolkit, name: readyFor(toolkit).name })),

    // The ready recipes of one connected account, saved (or updated: the same project or read keeps its recipe) in
    // one go, with no model and no sample calls. None has parameters: a sync recipe is kept with live_sync, a read
    // recipe is one fixed call. Returns { toolkit, made: [{ id, kind, name, short, estimate, ran }] }, or null when the
    // app has no ready recipes. A read with ran: false has never run: run it once (execute by id) so its result is known.
    async setup_recipes({ toolkit, account }) {
      const ready = readyFor(toolkit);
      if (!ready) return null;
      const run = async (tool, args, acc) => {
        const id = await accountId(acc, { strict: false });
        return composio.tools.execute(tool, { userId, arguments: args, ...(id && { connectedAccountId: id }), dangerouslySkipVersionCheck: true });
      };
      const specs = await ready.recipes({ run, account });
      // Every description embedded in a few calls, not one per recipe.
      const vectors = [];
      for (let i = 0; i < specs.length; i += 64) {
        const batch = specs.slice(i, i + 64).map((x) => `${x.description}\ntags: ${x.tags.join(", ")}\ntool: ${x.tool ?? partsTool(x.recipe)}`);
        // Without embeddings the recipes are still made; search finds them once they are made again.
        vectors.push(...(openrouterApiKey ? await embedMany(batch).catch((e) => (console.error("genter: recipe embeddings failed:", e.message), batch.map(() => null))) : batch.map(() => null)));
      }
      const created_at = new Date().toISOString();
      const made = [];
      for (const [i, x] of specs.entries()) {
        const id = `${x.kind === "read" ? "read" : "sync"}_${createHash("sha256").update(`${userId}:${toolkit}:${account ?? ""}:${x.key}`).digest("hex").slice(0, 24)}`;
        const old = await store.get(id).then((row) => row && open(row.blob)).catch(() => null);
        const memory = {
          created_at,
          tags: x.tags,
          description: x.description,
          short: x.short,
          status: "valid",
          ...(vectors[i] && { embedding: vectors[i] }),
          ...(old?.memory?.disabled && { disabled: old.memory.disabled }),
          ...(x.kind === "read" && { account }),
        };
        if (x.kind === "read") {
          // A read keeps its last result (digest, summary) when it is made again.
          await save({ ...old, id, tool: x.tool, args: x.args, created_at: old?.created_at ?? created_at, memory, ready: toolkit });
        } else {
          const recipe = { ...x.recipe, ...(x.estimate && { estimate: x.estimate }), ready: toolkit };
          await save({ ...(old && { summary: old.summary }), id, kind: "sync", tool: partsTool(recipe), args: {}, sync: recipe, created_at: old?.created_at ?? created_at, memory });
        }
        made.push({ id, kind: x.kind, name: x.name, short: x.short, estimate: x.estimate ?? null, ...(x.kind === "read" && { ran: Boolean(old?.digest) }) });
      }
      return { toolkit, made };
    },
    setup_sync: (args) => api.setup_recipes(args),

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
      if (once || synced.status === "failed") return synced;
      // Triggers bring changes as they happen; the schedule is a safety net for what they miss (daily with
      // triggers, the recipe's own pace without them).
      let watched = null;
      if (plan.triggers?.length) {
        watched = await sources.watch({ id: source.id }).catch((e) => ({ watching: [], watch_error: e.message }));
      }
      const on = watched?.watching?.length > 0;
      const scheduled = await sources.schedule({ id: source.id, every: on ? Math.max(plan.every ?? 1440, 1440) : (plan.every ?? 60) });
      return { ...scheduled, watch_error: watched?.watch_error ?? scheduled.watch_error };
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

// How people say it -> how tool slugs say it.
const SYNONYMS = {
  create: ["insert", "add"], add: ["insert", "create"], new: ["create", "insert"], make: ["create", "insert"],
  show: ["list", "get"], what: ["list"], which: ["list"], my: ["list", "authenticated"], have: ["authenticated"], all: ["list"], find: ["search", "list"],
  edit: ["update", "patch"], change: ["update", "patch"], rename: ["update", "patch"], remove: ["delete"],
  latest: ["list"], recent: ["list"], send: ["send", "create"], write: ["create", "send"],
};
const appTools = new Map(); // toolkit -> { at, list: Promise<tools> }
const appVectors = new Map(); // toolkit -> { at, list: Promise<[slug, embedding][]> }

// Connected apps the text names: "Google Tasks" -> googletasks.
export function namedApps(text, apps = []) {
  const flat = String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...new Set(apps)].filter((slug) => slug && flat.includes(slug.toLowerCase().replace(/[^a-z0-9]/g, "")));
}

// An app's tools ranked for a query. Composio's search inside a toolkit is alphabetical, so "list my tasks"
// in Google Tasks gave BATCH_EXECUTE, BULK_INSERT, CLEAR... and never LIST_TASKS. Words of the query in the
// slug count most, then in the description; reading tools win ties, so a question gets a tool that reads.
// `semantic`: the query's similarity to each tool, when there are vectors; the words then only break ties.
export function rankTools(tools, query, limit, semantic = null) {
  const stem = (w) => w.replace(/(ies|es|s)$/, "");
  const said = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const words = [...new Set([...said, ...said.flatMap((w) => SYNONYMS[w] ?? [])].map(stem))];
  const scored = tools.map((t, i) => {
    const slug = t.slug.toLowerCase().split("_").map(stem);
    const text = String(t.description ?? "").toLowerCase();
    const score =
      words.filter((w) => slug.includes(w)).length * 3 +
      words.filter((w) => text.includes(w)).length +
      (readsOnly(t.slug, t.tags) ? 2 : 0) +
      (/_(LIST|SEARCH|FIND|FETCH)(_|$)/.test(t.slug) ? 1 : 0);
    return { t, score: semantic ? semantic[i] + score * 0.01 : score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ t }) => t);
}

// A tool that only reads, by Composio's hint or the verb in its slug.
function readsOnly(slug, tags = []) {
  if (tags.includes("readOnlyHint")) return true;
  const s = slug.toUpperCase();
  if (/_(SEND|CREATE|DELETE|REMOVE|UPDATE|PATCH|POST|REPLY|FORWARD|MOVE|ARCHIVE|TRASH|ADD|INSERT|UPLOAD|SET|INVITE|MERGE|CLOSE|PUBLISH|SHARE|EXECUTE|RUN|START|STOP|CANCEL|WATCH|PIN|UNPIN|FOLLOW|UNFOLLOW|MODIFY|CLEAR|BATCH_UPDATE|IMPORT|COPY)(_|$)/.test(s)) return false;
  return /_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|HISTORY|EXPORT|DOWNLOAD)(_|$)/.test(s);
}

// "### Fetch unread emails\n..." -> "Fetch unread emails".
const titleOf = (md) => (String(md ?? "").split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").replace(/[`*_]/g, "").trim().slice(0, 80);

// A recipe named by its result: "### Open pull requests of Genterai/genter-cli", what it holds, the call.
function resultRecipe({ title, about }, tool) {
  return `### ${title}\n\n${about ?? ""}\n\n\`${tool}\``.replace(/\n{3,}/g, "\n\n");
}

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

// The call a sync recipe is named by: its first list (a repository's files for a project).
const partsTool = (recipe) => (recipe.parts?.find((p) => p.read) ?? recipe.parts?.[0] ?? recipe)?.list?.tool ?? "SYNC";

// Date placeholders of a recipe's args filled for this run: {{now}}, {{today}}, {{tomorrow}}, {{ago.7d}}, {{ahead.30d}}.
function withDates(args) {
  if (!JSON.stringify(args ?? {}).includes("{{")) return args;
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const at = (days, from = Date.now()) => new Date(from + days * 86_400_000).toISOString();
  const span = (sign) => Object.fromEntries([1, 2, 7, 14, 30, 90, 180, 365].map((d) => [`${d}d`, at(sign * d)]));
  return fill(args, { now: at(0), today: day.toISOString(), tomorrow: at(1, day.getTime()), yesterday: at(-1, day.getTime()), ago: span(-1), ahead: span(1) });
}
