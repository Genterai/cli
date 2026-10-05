import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Composio } from "@composio/core";
import { canonicalArgs, canonicalJson, classifyFailure, contentHash, isPartial, normalizeLegacy, publicRecipe, recipeId, sourceOf } from "./recipe.js";
import { fill, inferList, pick } from "./shape.js";

// Genter = Composio + recipes of past calls.
// A Recipe is ONE successful tool call with fixed args plus knowledge about its actual result (see recipe.js and
// docs: specs/recipes.md). Its id is deterministic (workspace, account, tool, canonical args): the same call upserts the
// same record. The raw result is never stored: only a digest, a semantic summary, one line per item and their vectors.
// execute() runs the REAL tool every time. Unchanged result (same digest): only checked_at moves, no model is called.
// Changed result: the same recipe is described and embedded again. Failed call: no recipe; one that exists is marked
// gone / denied when the error says so.
// Records are encrypted before they reach the store, so the store only sees rows { id, remembered, blob }
// and needs: get(id), put(row), all() (remembered rows); remove(id) (optional).
// scopes (optional): { get, put, list, remove } of prepared areas { id, label, toolkit, account, spec }.
// workspaceId: part of every recipe id (default: userId).
// triggers: true only where Composio's webhook reaches this code (the hosted backend); the CLI can not receive events.
// allow(record) (optional): false hides a recipe from search (the backend: connections the person may use).
export function createGenter({ composioApiKey, openrouterApiKey, userId, workspaceId, secret, store, scopes: scopeStore, triggers = false, defer, allow, minScore = 0.25, strongScore = 0.45 }) {
  if (!secret) throw new Error("secret is required to encrypt stored calls");
  workspaceId ??= userId;
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
  const read = (row) => {
    try {
      return normalizeLegacy(open(row.blob));
    } catch {
      return null;
    }
  };
  const load = async (id) => {
    const row = await store.get(id);
    return row ? read(row) : null;
  };
  const loadOrThrow = async (id) => {
    const record = await load(id);
    if (!record) throw new Error(`Unknown recipe: ${id}`);
    return record;
  };
  const everyRecipe = async () => (await store.all()).map(read).filter(Boolean);
  const save = (record) => store.put({ id: record.id, remembered: true, blob: seal(pack(record)) });
  const drop = async (id) => {
    if (store.remove) return store.remove(id);
    await store.put({ id, remembered: false, blob: seal({ id, removed: true }) });
  };
  const pending = new Set();
  const later = (task) => {
    const p = task.catch((e) => console.error("genter: saving a recipe failed:", e.message));
    if (defer) return defer(p);
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  // OpenRouter chat call. The provider that answers first by default (OPENROUTER_SORT=latency|throughput|price): by price,
  // gpt-oss-120b went to providers that broke its JSON; by throughput, to ones 7x dearer and no quicker (README → Models).
  async function chat(body, timeout = 30000) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { sort: process.env.OPENROUTER_SORT || "latency" }, ...body }),
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
            model: process.env.QUERY_MODEL || process.env.SUMMARY_MODEL || "openai/gpt-oss-120b",
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

  // Several texts at once.
  async function embedMany(input) {
    if (!openrouterApiKey) throw new Error("Recipes need an OpenRouter key for embeddings (OPENROUTER_API_KEY)");
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small", input }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Embeddings failed: ${res.status} ${await res.text()}`);
    return (await res.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // What a result is and what it holds, from one model call: { title, short, summary, items }. The summary is
  // semantic: what the data MEANS (subjects, people, dates, ids), written only from what was returned. A partial
  // result (a page, truncated) is described as such and never claims more than it holds.
  async function describe(tool, args, data, { partial = false } = {}) {
    if (!openrouterApiKey) return null;
    const text = await chat({
      model: process.env.SUMMARY_MODEL || "openai/gpt-oss-120b",
      reasoning: { effort: "low" },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content:
            `A call of ${tool} with args ${JSON.stringify(args).slice(0, 600)} returned the data below. ` +
            'Reply with JSON only: {"title": "...", "short": "...", "summary": "...", "items": ["..."]}.\n' +
            'title: what this result is, as a name of up to 8 words for these exact args, in English, e.g. "Open pull requests of Genterai/genter-cli".\n' +
            "short: ONE sentence of up to 140 characters saying what this result is about and can answer (the content, not the call or its args). Not a repeat of the title.\n" +
            "summary: 2-4 sentences retelling what the result MEANS and contains, so it can be found later by topic: subjects, people, dates, decisions, " +
            "and the ids or URLs needed to open it again. Write in English, but quote subjects, titles and names exactly as they are.\n" +
            "items: up to 15 things the result holds, one short line each, the way someone would look for it: what it is, its " +
            'title or subject exactly as written, its date, e.g. "Calendar event «Уборка» on 2026-10-03 13:00". [] when it is empty.\n' +
            (partial
              ? "This result is only a PAGE or was cut off (the data carries a next-page marker or says it is truncated). Say in the summary that it is " +
                'the first part ("first N of more"), and claim ONLY what was returned: never totals, never "no more", never that something is absent.\n'
              : "") +
            "Only say what is in the data, do not guess. No passwords, tokens or keys." +
            `\n\n${forSummary(data).slice(0, 20000)}`,
        },
      ],
    }).catch(() => null);
    if (!text) return null;
    try {
      const out = JSON.parse(text);
      const clean = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
      const items = (Array.isArray(out.items) ? out.items : []).map((i) => clean(i, 200)).filter(Boolean).slice(0, 15);
      return { title: clean(out.title, 100)?.replace(/^#+\s*/, ""), short: clean(out.short, 200), summary: clean(out.summary, 1200), items };
    } catch {
      return { summary: text.slice(0, 1200) };
    }
  }

  // How well a recipe fits a request: its result summary and each thing it held (not the tool's description).
  // A line of its last result with a key term of the request in it or very close by meaning makes it a strong match;
  // a line somewhat close (0.33+) or a key term in the summary puts it among the recipes offered. matched: those lines.
  function resultMatch(r, vector, terms) {
    const lines = r.items ?? [];
    const byItem = (r.itemEmbeddings ?? []).map((e, i) => [lines[i], cosine(vector.slice(0, e.length), e)]);
    let score = r.summaryEmbedding ? cosine(vector, r.summaryEmbedding) : 0;
    const said = (text) => terms.some((t) => String(text ?? "").toLowerCase().includes(t));
    const close = byItem.filter(([l, s]) => l && s >= ITEM_FIT).sort((a, b) => b[1] - a[1]);
    const written = lines.filter(said);
    const matched = [...new Set([...written, ...close.map(([l]) => l)])].slice(0, 3);
    if (written.length || close[0]?.[1] >= ITEM_STRONG) score = Math.max(score, strongScore);
    else if (matched.length || said(r.summary)) score = Math.max(score, (minScore + strongScore) / 2);
    return { score, matched };
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

  // The trigger that fires when this call's result may change, chosen by a model with config it could fill: the
  // first of [{ slug, config, label }], or null.
  async function pickTrigger({ toolkit, tool, args, title }) {
    const types = await triggersOf(toolkit);
    if (!types.length || !openrouterApiKey) return null;
    const options = types.map((t) => ({
      slug: t.slug,
      description: String(t.description ?? "").split("\n")[0].slice(0, 140),
      required: t.config?.required ?? [],
      config: Object.keys(t.config?.properties ?? {}),
    }));
    const text = await chat(
      {
        model: process.env.BUILDER_MODEL || "google/gemma-4-31b-it",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `A recipe runs ${tool} with args ${JSON.stringify(args)}${title ? ` ("${String(title).slice(0, 200)}")` : ""}. ` +
              "Which of these triggers fire when its result may change (a new, updated or deleted item it would return)? " +
              'Reply with JSON only: {"triggers": [{"slug": "...", "config": {...}, "label": "on every new email"}]}. ' +
              "Fill every required config field from the args; skip a trigger you can not fill. Usually one; none fits: [].\n\n" +
              JSON.stringify(options),
          },
        ],
      },
      20000,
    );
    const picked = JSON.parse(text).triggers ?? [];
    const ok = picked.find((t) => {
      const type = types.find((x) => x.slug === t.slug);
      return type && !JSON.stringify(t.config ?? {}).includes("{{") && (type.config?.required ?? []).every((k) => t.config?.[k] != null && t.config[k] !== "");
    });
    return ok ? { slug: ok.slug, config: ok.config ?? {}, label: String(ok.label || ok.slug).slice(0, 60) } : null;
  }

  // The slow part of a call, after its result went back: description, vectors, provenance. Merged into what is stored
  // NOW (a later execute may have bumped checked_at or changed the digest meanwhile: then this description is stale and dropped).
  async function remember(id, digest, data, { created }) {
    let record = await load(id);
    if (!record || record.digest !== digest) return record;
    const partial = isPartial(data);
    const named = (await describe(record.tool, record.args, data, { partial })) ?? (await describe(record.tool, record.args, data, { partial }));
    const info = created ? await toolInfo(record.tool) : null;
    const toolkit = info?.toolkit?.slug ?? record.scope?.toolkit;
    // The model sees the first part of a long result; every listed item gets its own line too.
    const lines = named ? [...new Set([...(named.items ?? []), ...listLines(data)])].slice(0, MAX_ITEMS) : [];
    let summaryEmbedding;
    let itemEmbeddings;
    if (named?.summary) {
      const vectors = await embedMany([named.summary, ...lines]).catch(() => []);
      [summaryEmbedding, ...itemEmbeddings] = vectors;
      itemEmbeddings = itemEmbeddings?.length ? itemEmbeddings.map((e) => e.slice(0, ITEM_DIMS)) : undefined;
    }
    record = await load(id);
    if (!record || record.digest !== digest) return record;
    record = {
      ...record,
      scope: { ...record.scope, toolkit: toolkit ?? record.scope?.toolkit },
      partial,
      source: sourceOf({ tool: record.tool, args: record.args, toolkit, data }),
      ...(named && {
        title: named.title ?? record.title,
        short: named.short ?? named.title ?? record.short,
        summary: named.summary ?? null,
        items: lines.length ? lines : undefined,
        summaryEmbedding,
        itemEmbeddings,
      }),
    };
    await save(record);
    // The model proposes how to keep it current, once, when the recipe is first saved.
    if (created && !record.trigger?.recommended) await api.recipes.recommendTrigger(id).catch(() => null);
    return load(id);
  }

  const toolkitOf = (tool) => String(tool).split("_")[0].toLowerCase();
  const now = () => new Date().toISOString();

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

    // Saved recipes first (which call to make: the result summary says what it returned once, it is not the current
    // value), plain Composio tools as fallback. Only fresh, enabled recipes. A non-English query is matched in its
    // language and in English. `apps`: the connected toolkits; those the query names give their tools first.
    // `toolkits`: apps to search in anyway. `tools`: Composio tools come too even when a recipe fits well.
    async search({ query, limit = 5, apps = [], toolkits: also = [], tools: withTools = false }) {
      const english = await translate(query);
      const toolkits = [...new Set([...also, ...namedApps(`${query} ${english?.en ?? ""}`, apps)])];
      const vector = await embed(english?.en ? `${query}\n${english.en}` : query).catch(() => null);
      const terms = (english?.terms ?? []).map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 4);
      const memories = vector
        ? (await everyRecipe())
            .filter((r) => r.status === "fresh" && !r.disabled && r.summaryEmbedding && (!allow || allow(r)))
            .map((r) => ({ r, ...resultMatch(r, vector, terms) }))
            .filter(({ score }) => score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ r, score, matched }) => ({
              id: r.id,
              tool: r.tool,
              args: r.args,
              title: r.title,
              short: r.short,
              summary: r.summary,
              ...(matched.length && { matched }),
              score: Number(score.toFixed(2)),
              status: r.status,
              updated_at: r.updated_at,
              checked_at: r.checked_at,
              trigger: { active: Boolean(r.trigger?.active) },
            }))
        : [];
      if (!withTools && memories.some((m) => m.score >= strongScore)) return memories;

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

    // Run the REAL tool (always: a recipe is never the current value). Pass `id` to repeat a saved recipe (args are
    // merged on top). `account` picks a connection (from login) when an app is connected several times.
    // Returns { id, result, created, changed, unchanged, pending, recipe_status }:
    //   created: a new recipe; changed: the recipe's result is different now (it is described again);
    //   unchanged: same result, only checked_at moved. pending resolves to the recipe once its description is saved.
    // A failed call returns { result } (and recipe_status gone / denied, with the id, when it was a known recipe that
    // the error says is gone or forbidden). remember: false runs it without saving (an inner step).
    async execute({ id, tool, args = {}, account, remember: keep = true }) {
      const previous = id ? await load(id) : null;
      if (id && !previous && !tool) throw new Error(`Unknown recipe: ${id}`);
      if (previous) {
        tool ??= previous.tool;
        args = { ...previous.args, ...args };
        account ??= previous.scope?.account || undefined; // a recipe runs on the account it was made for
      }
      if (!tool) throw new Error("Pass `tool` or `id`");
      account = await accountId(account); // an alias from login
      let result;
      try {
        // Dates stay placeholders in the recipe ({{today}}, {{ago.7d}}) and are filled for this run.
        result = await composio.tools.execute(tool, {
          userId,
          arguments: withDates(args),
          ...(account && { connectedAccountId: account }),
          dangerouslySkipVersionCheck: true,
        });
      } catch (e) {
        // The SDK wraps API errors ("Error executing the tool X"): the cause says what happened (not found, forbidden...).
        const error = [e.message, e.cause?.message, e.cause?.error?.error?.message].filter((x, i, all) => x && all.indexOf(x) === i).join(": ");
        result = { successful: false, error, data: null };
      }
      if (!keep) return { result };
      const rid = recipeId({ workspaceId, scope: account ?? "", tool, args });
      const existing = previous?.id === rid ? previous : await load(rid);
      const at = now();

      if (!result.successful) {
        // No recipe from a failed call. A known one learns what the error says: gone, or denied.
        const failure = classifyFailure(result.error);
        if (existing && failure) {
          await save({ ...existing, status: failure, checked_at: at });
          return { id: rid, result, created: false, changed: false, unchanged: false, recipe_status: failure };
        }
        return { result };
      }

      const digest = contentHash(result.data);
      if (existing && existing.digest === digest && (existing.summary || !openrouterApiKey)) {
        // Same result: nothing is described or embedded again.
        const next = { ...existing, status: "fresh", checked_at: at };
        if (existing.status !== "fresh" || existing.checked_at !== at) await save(next);
        return { id: rid, result, created: false, changed: false, unchanged: true, pending: Promise.resolve(publicRecipe(next)), recipe_status: "fresh" };
      }
      const created = !existing;
      // A recipe of the old model (random id) re-keys here: its knowledge is kept when the result is the same.
      const legacy = created && previous?.legacy && previous.tool === tool && canonicalJson(previous.args) === canonicalJson(args) ? previous : null;
      const kept = legacy && legacy.summaryEmbedding && legacy.digest === createHash("sha256").update(JSON.stringify(result.data)).digest("hex") ? legacy : null;
      const base = existing ?? {
        id: rid,
        tool,
        args: canonicalArgs(args),
        scope: { account: account ?? "", toolkit: toolkitOf(tool) },
        created_at: legacy?.created_at ?? at,
        trigger: legacy?.trigger ?? { active: false, spec: null, id: null },
        ...(legacy?.disabled && { disabled: legacy.disabled }),
        ...(kept && { title: kept.title, short: kept.short, summary: kept.summary, items: kept.items, summaryEmbedding: kept.summaryEmbedding, itemEmbeddings: kept.itemEmbeddings, source: kept.source, partial: kept.partial }),
      };
      const record = { ...base, digest, status: "fresh", updated_at: at, checked_at: at };
      // The call as it ran: args kept as written (placeholders included), in canonical form so equal calls look equal.
      await save(record);
      if (legacy && legacy.id !== rid) await drop(legacy.id).catch(() => {});
      const described = kept ? Promise.resolve(publicRecipe(record)) : remember(rid, digest, result.data, { created }).then(publicRecipe);
      later(described);
      return { id: rid, result, created, changed: !created, unchanged: false, pending: described.catch(() => null), recipe_status: "fresh" };
    },

    // Recipes: everything saved, one by one, or a prepared area.
    recipes: {
      // Every recipe (any status, without vectors), newest result first.
      async list() {
        return (await everyRecipe()).map(publicRecipe).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      },
      async get(id) {
        return publicRecipe(await load(id));
      },
      // Deletes the recipe (and turns its trigger off).
      async remove(id) {
        const record = await load(id);
        if (!record) return { id, removed: false };
        if (record.trigger?.id && record.trigger.active) await composio.triggers.disable(record.trigger.id).catch(() => {});
        await drop(id);
        return { id, removed: true };
      },
      // Runs the saved call again: { recipe, changed, status }. status: fresh | gone | denied | failed (a failure that
      // says nothing about the recipe: a timeout, a bad argument).
      async recheck(id) {
        const record = await loadOrThrow(id);
        const out = await api.execute({ id, account: record.scope?.account || undefined });
        if (out.pending) await out.pending;
        const status = out.recipe_status ?? (out.result?.successful === false ? "failed" : "fresh");
        return { recipe: publicRecipe(await load(id)), changed: Boolean(out.changed), status, ...(status === "failed" && { error: out.result?.error }) };
      },
      // Marks every recipe of a revoked / deleted connection (by account id, or by app) as denied: count.
      async invalidateAccount({ account, toolkit } = {}) {
        if (!account && !toolkit) throw new Error("Pass account or toolkit");
        let count = 0;
        for (const r of await everyRecipe()) {
          if (account && r.scope?.account !== account) continue;
          if (toolkit && r.scope?.toolkit !== toolkit) continue;
          if (r.status === "denied") continue;
          await save({ ...r, status: "denied", checked_at: now() });
          count++;
        }
        return { count };
      },
      // The object is gone (deleted upstream): the recipe stays but is never retrieved as fresh.
      async markGone(id) {
        const record = await loadOrThrow(id);
        await save({ ...record, status: "gone", checked_at: now() });
        return publicRecipe(await load(id));
      },
      // The trigger spec a model picks for this recipe's app: { slug, config, label }, or null. Cached in
      // record.trigger.spec (null too: it is asked once).
      async recommendTrigger(id) {
        const record = await loadOrThrow(id);
        if (record.trigger?.spec) return record.trigger.spec;
        if (record.trigger?.recommended) return null;
        const spec = await pickTrigger({ toolkit: record.scope?.toolkit ?? toolkitOf(record.tool), tool: record.tool, args: record.args, title: record.title }).catch(() => null);
        await save({ ...record, trigger: { active: false, id: null, ...record.trigger, spec: spec ?? null, recommended: true } });
        return spec ?? null;
      },
      // Turns "keep this current" on (creates or re-enables the Composio trigger of its spec) or off.
      async setTrigger({ id, active }) {
        const record = await loadOrThrow(id);
        const trigger = { spec: null, id: null, ...record.trigger };
        if (active) {
          if (!triggers) throw new Error("Triggers need the hosted backend: Composio events do not reach this process");
          const spec = trigger.spec ?? (await api.recipes.recommendTrigger(id));
          if (!spec) throw new Error("No trigger fits this recipe");
          const fresh = await loadOrThrow(id);
          trigger.spec = spec;
          trigger.id = fresh.trigger?.id ?? null;
          if (trigger.id && composio.triggers.enable) await composio.triggers.enable(trigger.id).catch(() => (trigger.id = null));
          if (!trigger.id) {
            const connected = record.scope?.account ? await accountId(record.scope.account, { strict: false }) : undefined;
            trigger.id = (await composio.triggers.create(userId, spec.slug, { ...(connected && { connectedAccountId: connected }), triggerConfig: spec.config })).triggerId;
          }
        } else if (trigger.id) {
          await composio.triggers.disable(trigger.id).catch(() => {});
        }
        await save({ ...(await loadOrThrow(id)), trigger: { ...trigger, recommended: true, active: Boolean(active) } });
        return publicRecipe(await load(id));
      },
      // The recipes a Composio trigger keeps current (an event names the trigger id).
      async byTrigger({ triggerId }) {
        return (await everyRecipe()).filter((r) => r.trigger?.id === triggerId).map(publicRecipe);
      },
      // A prepared area: minimal record, so events know it was prepared. No recipe of its own.
      async prepareScope({ label, toolkit, account = "" }) {
        if (!scopeStore) throw new Error("No scopes store");
        const id = `scp_${createHash("sha256").update([workspaceId, toolkit, account, label].join("|")).digest("hex").slice(0, 24)}`;
        const old = await scopeStore.get(id);
        const record = { spec: null, ...old, id, label, toolkit, account };
        await scopeStore.put(record);
        return record;
      },
      async scopes() {
        return scopeStore ? scopeStore.list() : [];
      },
    },

    // Waits for recipes still being saved (the CLI calls it before exiting).
    async flush() {
      await Promise.all([...pending]);
    },

    // Every tool of an app as Composio describes it ({ slug, description, inputParameters, tags }), cached for an hour:
    // which of them write at a reference (refs.js writeHints).
    catalog: ({ toolkit }) => toolsOf([toolkit]),

    // Full argument schema of a tool, for the agent.
    async schema(tool) {
      const t = await composio.tools.getRawComposioToolBySlug(tool);
      return { tool: t.slug, description: t.description, args: t.inputParameters };
    },
  };
  return api;
}

// A result's items get a line each, up to MAX_ITEMS, embedded and kept as their first ITEM_DIMS dimensions (int8):
// text-embedding-3 vectors keep their meaning when cut (Matryoshka), «Уборка» vs "когда мне убираться" is 0.40 at 1536
// and 0.41 at 256, unrelated events stay under 0.22, and 100 lines cost ~34 KB instead of 600.
const MAX_ITEMS = 100;
const ITEM_DIMS = 256;
// How close a line of a result is to a request (256 dims): «Уборка» to "когда мне убираться" 0.40, to "when should I
// clean" 0.36, to "когда уборка" 0.56; "Стоматолог" to "когда к стоматологу" 0.60; unrelated lines mostly under 0.30,
// a few short ones up to 0.35.
const ITEM_FIT = 0.33;
const ITEM_STRONG = 0.45;
const decrypted = new Map(); // "<user>:<blob prefix>" -> record, shared by every genter in the process
const translations = new Map(); // query -> Promise<{ en, terms } | null>

// Embeddings are stored as base64 float32 (8 KB instead of ~30 KB of JSON numbers each); older records keep arrays.
const VECTORS = ["summaryEmbedding"];
// A result's item vectors are int8 (1.5 KB each; cosine does not care about their scale).
function pack(record) {
  const out = { ...record };
  for (const key of VECTORS) if (out[key]) out[key] = toB64(out[key]);
  if (out.itemEmbeddings) out.itemEmbeddings = out.itemEmbeddings.map(toI8);
  return out;
}
function unpack(record) {
  for (const key of VECTORS) if (typeof record[key] === "string") record[key] = fromB64(record[key]);
  if (record.itemEmbeddings) record.itemEmbeddings = record.itemEmbeddings.map(fromI8);
  if (typeof record.memory?.embedding === "string") record.memory.embedding = fromB64(record.memory.embedding); // legacy
  return record;
}
const toB64 = (v) => (typeof v === "string" ? v : Buffer.from(Float32Array.from(v).buffer).toString("base64"));
const toI8 = (v) => {
  if (typeof v === "string") return v;
  const max = Math.max(...Array.from(v, Math.abs)) || 1;
  return Buffer.from(Int8Array.from(v, (x) => Math.round((x / max) * 127)).buffer).toString("base64");
};
const fromI8 = (s) => (typeof s === "string" ? new Int8Array(Uint8Array.from(Buffer.from(s, "base64")).buffer) : s);
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
// Words that say nothing about a tool: "the" matched every ..._FOR_THE_AUTHENTICATED_USER slug.
const STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "they", "them", "their", "are", "was", "its", "into", "please"]);
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
  const said = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
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

// One line per item of a list result: its title and when, e.g. "Уборка (2026-10-08 13:00)".
const TITLE_KEYS = ["summary", "title", "subject", "name", "full_name", "display_name", "notes", "snippet", "text"];
const WHEN_KEYS = ["start.dateTime", "start.date", "due", "date", "messageTimestamp", "internalDate", "created_at", "createdAt", "created", "updated"];
export function listLines(data) {
  const shape = data && typeof data === "object" ? inferList(data) : { single: true };
  if (shape.single) return [];
  return [pick(data, shape.items)]
    .flat()
    .filter((x) => x && typeof x === "object")
    .map((raw) => {
      const title = TITLE_KEYS.map((k) => raw[k]).find((v) => typeof v === "string" && v.trim()) ?? pick(raw, shape.title);
      if (title == null || String(title).trim() === "") return null;
      const when = WHEN_KEYS.map((k) => pick(raw, k)).find((v) => v != null && v !== "");
      const at = when == null ? "" : /^\d{12,13}$/.test(String(when)) ? new Date(Number(when)).toISOString() : String(when);
      return `${String(title).replace(/\s+/g, " ").trim().slice(0, 160)}${at ? ` (${at.replace("T", " ").slice(0, 16)})` : ""}`;
    })
    .filter(Boolean);
}

// A result as the summary model reads it: bookkeeping fields out and long texts cut, so 20,000 characters hold the
// whole list, not its first 15 events.
const NOISE = /^(etag|kind|iCalUID|sequence|reminders|eventType|node_id|gravatar_id|avatar_url|(?!html_)\w+_url|_links|headers|payload)$/;
function forSummary(data) {
  const list = data && typeof data === "object" && !inferList(data).single; // one file or page is read whole
  return JSON.stringify(data, (key, value) => {
    if (NOISE.test(key)) return undefined;
    if (list && typeof value === "string" && value.length > 400) return `${value.slice(0, 400)}…`;
    return decodeBase64(key, value);
  });
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

// Date placeholders of a recipe's args filled for this run: {{now}}, {{today}}, {{tomorrow}}, {{ago.7d}}, {{ahead.30d}}.
function withDates(args) {
  if (!JSON.stringify(args ?? {}).includes("{{")) return args;
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const at = (days, from = Date.now()) => new Date(from + days * 86_400_000).toISOString();
  const span = (sign) => Object.fromEntries([1, 2, 7, 14, 30, 90, 180, 365].map((d) => [`${d}d`, at(sign * d)]));
  return fill(args, { now: at(0), today: day.toISOString(), tomorrow: at(1, day.getTime()), yesterday: at(-1, day.getTime()), ago: span(-1), ahead: span(1) });
}
