import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Composio } from "@composio/core";
import { logCost, roughTokens, usageFields, withCost } from "./cost.js";
import { addMcpServer, isCustomToolkit, mcpUrl } from "./mcp.js";
import { areaOf, canonicalArgs, canonicalJson, classifyFailure, contentHash, isPartial, normalizeLegacy, publicRecipe, recipeId, sourceOf } from "./recipe.js";
import { fill, inferList, pick } from "./shape.js";
import { addIntent, chunkCall, fileCall, isSkillTool, LIMITS as SKILL_LIMITS, SCRIPT_NOTE, SKILL_TOOLS } from "./skills.js";
import { crawl, forgetPage, readPage, siteUrl, underSite } from "./web.js";

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
// skills (optional): the host's store of skills (skills.js, specs/skills.md): { list(): [{ id, name, version, embedding, chunks:
// [{ id, path, title, headings, refs, see, embedding }], files: [{ path, kind, mime, size }] }], get(id), text(id, path),
// file(id, path): { text } | { url } }. It lets search offer the pieces of skills and lets two local tools read them:
// SKILL_READ_CHUNK and SKILL_GET_FILE. A skill is never one Recipe; each read is one call, saved like any other.
export function createGenter({ composioApiKey, openrouterApiKey, userId, workspaceId, secret, store, scopes: scopeStore, skills, triggers = false, defer, allow, minScore = 0.25, strongScore = 0.45 }) {
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
  async function chat(body, timeout = 30000, source = "llm") {
    const started = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { sort: process.env.OPENROUTER_SORT || "latency" }, ...body }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      logCost({ type: "llm", model: body.model, source, ok: false, ms: Date.now() - started });
      throw new Error(`OpenRouter ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    logCost({ type: "llm", model: body.model, source, ms: Date.now() - started, ...usageFields(data) });
    return data.choices[0].message.content?.trim() ?? "";
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
      const vectors = (await Promise.all(chunks.map((c) => embedMany(c.map(text), "tool_embed")))).flat();
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
          "query_translate",
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
  async function embed(text, source = "embed") {
    if (!openrouterApiKey) return null;
    const started = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small", input: text }),
    });
    const model = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
    if (!res.ok) {
      logCost({ type: "embedding", model, source, texts: 1, ok: false, ms: Date.now() - started });
      throw new Error(`Embeddings failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    logEmbedding(data, model, source, [text], started);
    return data.data[0].embedding;
  }

  // Composio's own sign-in for an app; an app it has none for (an MCP server added by its address) signs in its own
  // way (OAuth with client registration, an API key), with nothing to fill in here.
  async function newAuthConfig(toolkit) {
    try {
      return (await composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name: `${toolkit} auth config` })).id;
    } catch (e) {
      const mode = (await composio.toolkits.get(toolkit).catch(() => null))?.authConfigDetails?.[0]?.mode;
      if (!mode || mode === "NO_AUTH") throw e;
      return (await composio.authConfigs.create(toolkit, { type: "use_custom_auth", authScheme: mode, credentials: {}, name: `${toolkit} auth config` })).id;
    }
  }

  // Tools that run here, not in Composio: a website's page (web.js).
  // Skills (skills.js): reading one piece of a skill and handing over one file of it. Genter never runs a script.
  const skillTools = skills && {
    // A call fixed to a version: a skill that changed since is "not found" for it, so the recipe goes gone (outdated).
    async [SKILL_TOOLS.chunk]({ skill, version, chunk } = {}) {
      const s = await skills.get(skill);
      if (!s) return { successful: false, error: `Skill not found: ${skill} (deleted)`, data: null };
      if (s.version !== version) return { successful: false, error: `Skill "${s.name}" at version ${version} not found: it is now at ${s.version}. This recipe is outdated`, data: null };
      const c = s.chunks.find((x) => x.id === chunk);
      if (!c) return { successful: false, error: `Section not found in skill "${s.name}": ${chunk}`, data: null };
      const text = (await skills.text(skill, c.path)) ?? "";
      const call = (tool, args) => ({ tool, args, id: recipeId({ workspaceId, scope: "", tool, args }) });
      const kinds = new Map(s.files.map((f) => [f.path, f]));
      return {
        successful: true,
        data: {
          skill: { id: s.id, name: s.name, version: s.version },
          section: { id: c.id, path: c.path, title: c.title, headings: c.headings },
          text: text.slice(c.start, c.end).trim(),
          // Files this section points to, one call each: the agent takes them with its next calls. Code is labelled as such.
          related: (c.refs ?? []).map((path) => {
            const f = kinds.get(path);
            return { path, kind: f?.kind ?? "artifact", ...(f?.kind === "script" && { executable_code: true, note: SCRIPT_NOTE }), size: f?.size, get: call(SKILL_TOOLS.file, fileCall(skill, version, path).args) };
          }),
          see_also: (c.see ?? []).map((id) => {
            const o = s.chunks.find((x) => x.id === id);
            return { section: id, title: o?.title, get: call(SKILL_TOOLS.chunk, chunkCall(skill, version, id).args) };
          }),
        },
      };
    },
    // One file as it is: text inline when small, a link into the host's storage when large or binary; scripts carry the
    // "executable code" label and are never run.
    async [SKILL_TOOLS.file]({ skill, version, path } = {}) {
      const s = await skills.get(skill);
      if (!s) return { successful: false, error: `Skill not found: ${skill} (deleted)`, data: null };
      if (s.version !== version) return { successful: false, error: `Skill "${s.name}" at version ${version} not found: it is now at ${s.version}. This recipe is outdated`, data: null };
      const f = s.files.find((x) => x.path === path);
      if (!f) return { successful: false, error: `File not found in skill "${s.name}": ${path}`, data: null };
      const got = await skills.file(skill, path);
      if (!got) return { successful: false, error: `File not found in skill "${s.name}": ${path}`, data: null };
      return {
        successful: true,
        data: {
          skill: { id: s.id, name: s.name, version: s.version },
          path,
          kind: f.kind,
          mime: f.mime,
          size: f.size,
          ...(f.kind === "script" && { executable_code: true, note: SCRIPT_NOTE }),
          ...(got.text != null ? { text: got.text } : { url: got.url, note: `${f.kind === "script" ? `${SCRIPT_NOTE} ` : ""}Too large or binary to return here: fetch the url (needs the same sign-in).`.trim() }),
        },
      };
    },
  };
  const LOCAL = { WEBSITE_READ_PAGE: readPage, ...skillTools };

  // A connection alias from login -> its account id. Unknown aliases stay as they are (strict) or mean the default.
  async function accountId(account, { strict = true } = {}) {
    if (!account || account.startsWith("ca_")) return account || undefined;
    if (account.startsWith("own_")) return undefined; // kept by the host, not Composio: a server with no sign-in, a website
    const { items } = await composio.connectedAccounts.list({ userIds: [userId], limit: 100 });
    return items.find((a) => a.alias === account)?.id ?? (strict ? account : undefined);
  }

  // One event per embeddings request: how many texts and tokens (the provider's count, else about 4 characters a token).
  function logEmbedding(data, model, source, texts, started) {
    const reported = data?.usage?.prompt_tokens;
    logCost({ type: "embedding", model, source, texts: texts.length, tokens_in: reported ?? roughTokens(texts), ...(reported == null && { tokens_estimated: true }), provider_cost_usd: data?.usage?.cost, ms: Date.now() - started });
  }

  // Several texts at once.
  async function embedMany(input, source = "embed") {
    if (!openrouterApiKey) throw new Error("Recipes need an OpenRouter key for embeddings (OPENROUTER_API_KEY)");
    const started = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small", input }),
      signal: AbortSignal.timeout(60000),
    });
    const model = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
    if (!res.ok) {
      logCost({ type: "embedding", model, source, texts: input.length, ok: false, ms: Date.now() - started });
      throw new Error(`Embeddings failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    logEmbedding(data, model, source, input, started);
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // What a result is and what it holds, from one model call: { title, short, summary, items, keywords }. The summary is
  // semantic: what the data MEANS (subjects, people, dates, ids), written only from what was returned. A partial
  // result (a page, truncated) is described as such and never claims more than it holds. keywords: the words people
  // search with that the result's own text rarely has (the kind of thing, synonyms, the app, both languages), embedded
  // with the summary: "почта" finds an inbox described as "Unread emails from today".
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
            'Reply with JSON only: {"title": "...", "short": "...", "summary": "...", "items": ["..."], "keywords": ["..."]}.\n' +
            'title: what this result is, as a name of up to 8 words for these exact args, in English, e.g. "Open pull requests of Genterai/genter-cli".\n' +
            "short: ONE sentence of up to 140 characters saying what this result is about and can answer (the content, not the call or its args). Not a repeat of the title.\n" +
            "summary: 2-4 sentences retelling what the result MEANS and contains, so it can be found later by topic: the app and the kind of things it holds, " +
            "subjects, people, companies, projects, dates, decisions, and the ids or URLs needed to open it again. Use the plain words people search with " +
            "(email, meeting, invoice, pull request, task). Write in English, but quote subjects, titles and names exactly as they are.\n" +
            "items: up to 15 things the result holds, one short line each, the way someone would look for it: what it is, its " +
            'title or subject exactly as written, its date, e.g. "Calendar event «Уборка» on 2026-10-03 13:00". [] when it is empty.\n' +
            "keywords: 10-25 search keywords and short phrases (1-3 words each) someone would type to find this result later: the app, the kind " +
            "of thing (email, inbox, calendar event, pull request, invoice), synonyms and related words (meeting, call, appointment), the topics, and " +
            "the people, companies, projects and places named in it. In English, and the same words again in the language of the data when it is not " +
            'English (e.g. "email", "inbox", "unread", "почта", "письма", "входящие"). Lowercase, no repeats.\n' +
            (partial
              ? "This result is only a PAGE or was cut off (the data carries a next-page marker or says it is truncated). Say in the summary that it is " +
                'the first part ("first N of more"), and claim ONLY what was returned: never totals, never "no more", never that something is absent.\n'
              : "") +
            "Only say what is in the data, do not guess. No passwords, tokens or keys." +
            `\n\n${forSummary(data).slice(0, 20000)}`,
        },
      ],
    }, 30000, "recipe_summary").catch(() => null);
    if (!text) return null;
    try {
      const out = JSON.parse(text);
      const clean = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
      const items = (Array.isArray(out.items) ? out.items : []).map((i) => clean(i, 200)).filter(Boolean).slice(0, 15);
      const keywords = [...new Set((Array.isArray(out.keywords) ? out.keywords : []).map((k) => clean(k, 60)?.toLowerCase()).filter(Boolean))].slice(0, 30);
      return { title: clean(out.title, 100)?.replace(/^#+\s*/, ""), short: clean(out.short, 200), summary: clean(out.summary, 1200), items, keywords };
    } catch {
      return { summary: text.slice(0, 1200) };
    }
  }

  // How well a recipe fits a request: its result summary and each thing it held (not the tool's description).
  // A line of its last result with a key term of the request in it or very close by meaning makes it a strong match;
  // a line somewhat close (0.33+) or a key term in the summary or its keywords puts it among the recipes offered.
  // matched: those lines.
  function resultMatch(r, vector, terms) {
    const lines = r.items ?? [];
    const byItem = (r.itemEmbeddings ?? []).map((e, i) => [lines[i], cosine(vector.slice(0, e.length), e)]);
    // Past requests this recipe answered count like its summary: a clumsy new question finds a similar old one.
    const past = (r.queryEmbeddings ?? []).map((q) => cosine(vector.slice(0, q.e.length), q.e));
    let score = Math.max(r.summaryEmbedding ? cosine(vector, r.summaryEmbedding) : 0, ...past);
    const said = (text) => terms.some((t) => String(text ?? "").toLowerCase().includes(t));
    const close = byItem.filter(([l, s]) => l && s >= ITEM_FIT).sort((a, b) => b[1] - a[1]);
    const written = lines.filter(said);
    const matched = [...new Set([...written, ...close.map(([l]) => l)])].slice(0, 3);
    if (written.length || close[0]?.[1] >= ITEM_STRONG) score = Math.max(score, strongScore);
    else if (matched.length || said(r.summary) || (r.keywords ?? []).some(said)) score = Math.max(score, (minScore + strongScore) / 2);
    return { score, matched };
  }

  // Vectors of the requests searched lately, by their text: execute({ task }) files the one it was made for on the
  // recipe (queryEmbeddings) without embedding it again.
  const askedVectors = new Map();
  const MAX_ASKED = 50;

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
      "trigger_pick",
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
  const remember = (id, digest, data, opts) => withCost({ entity_type: "recipe", entity_id: id }, () => rememberInner(id, digest, data, opts));
  async function rememberInner(id, digest, data, { created }) {
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
      const vectors = await embedMany([summaryText(named), ...lines], "recipe_embed").catch(() => []);
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
        keywords: named.keywords?.length ? named.keywords : undefined,
        summaryEmbedding,
        itemEmbeddings,
      }),
    };
    await save(record);
    // The model proposes how to keep it current, once, when the recipe is first saved.
    if (created && !record.trigger?.recommended) await api.recipes.recommendTrigger(id).catch(() => null);
    return load(id);
  }

  // The description of a skill's piece or file is made from the text itself, with no model: where it is, its start, the
  // words of its headings as keywords. One embedding call. A skill recipe is never about the whole skill.
  const rememberSkill = (id, digest, data) => withCost({ entity_type: "recipe", entity_id: id }, () => rememberSkillInner(id, digest, data));
  async function rememberSkillInner(id, digest, data) {
    let record = await load(id);
    if (!record || record.digest !== digest) return record;
    const name = data.skill?.name ?? "Skill";
    const flat = (t, n) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    let title;
    let summary;
    let path;
    let keywords;
    if (data.section) {
      path = [name, ...data.section.headings];
      title = flat(`${name}: ${data.section.headings.at(-1)}`, 100);
      summary = flat(`Section "${data.section.headings.join(" › ")}" of the skill "${name}". ${flat(data.text, 700)}`, 1200);
      keywords = [name, ...data.section.headings, "skill", "instructions", data.section.path];
    } else {
      path = [name, data.path];
      title = flat(`${name}: ${data.path}`, 100);
      const what = data.executable_code ? "Executable code (Genter does not run it)" : data.kind === "artifact" ? "File" : "File";
      summary = flat(`${what} "${data.path}" of the skill "${name}" (${data.mime}, ${data.size} bytes). ${data.text != null ? flat(data.text, 600) : "Given as a link: too large or binary."}`, 1200);
      keywords = [name, data.path, data.kind, "skill", data.executable_code ? "script" : "file"];
    }
    keywords = [...new Set(keywords.map((k) => flat(k, 60).toLowerCase()).filter(Boolean))].slice(0, 30);
    const named = { summary, keywords };
    const vectors = openrouterApiKey ? await embedMany([summaryText(named)], "recipe_embed").catch(() => []) : [];
    record = await load(id);
    if (!record || record.digest !== digest) return record;
    record = {
      ...record,
      scope: { ...record.scope, toolkit: "skill" },
      partial: false,
      source: { app: "Skill", path: path.slice(0, 6), url: null },
      title,
      short: flat(data.section ? flat(data.text, 140) : summary, 140),
      summary,
      items: data.section ? [data.section.headings.join(" › ")] : [data.path],
      keywords,
      ...(vectors[0] && { summaryEmbedding: vectors[0] }),
      trigger: { active: false, spec: null, id: null, recommended: true }, // a skill's content changes only by an update
    };
    await save(record);
    return load(id);
  }

  // Pieces of skills as search candidates: the skill is chosen by its description vector, the piece by its own. Pieces
  // already saved as recipes come through the recipes (same call = same id), the rest are offered as new calls with
  // fixed args. { id: null, kind: "skill", tool, args, title, description, skill, score, status: "new" }.
  async function skillCandidates(vector, limit) {
    const found = [];
    for (const s of await skills.list()) {
      const whole = s.embedding ? cosine(vector, s.embedding) : 0;
      for (const c of s.chunks) {
        const own = c.embedding ? cosine(vector.slice(0, c.embedding.length), c.embedding) : 0;
        const score = Math.max(own, 0.6 * own + 0.4 * whole);
        if (score < minScore) continue;
        const call = chunkCall(s.id, s.version, c.id);
        found.push({
          id: null,
          kind: "skill",
          tool: call.tool,
          args: call.args,
          title: `${s.name} › ${c.headings.join(" › ")}`,
          description: `Reads this section of the skill "${s.name}" (file ${c.path}). Execute it with exactly these args; the result lists the files it points to.`,
          skill: { id: s.id, name: s.name, version: s.version },
          recipe_id: recipeId({ workspaceId, scope: "", tool: call.tool, args: call.args }),
          score: Number(score.toFixed(2)),
          status: "new",
        });
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // The page recipes of a site (any status).
  const websitePages = async (site) =>
    (await everyRecipe()).filter((r) => r.tool === "WEBSITE_READ_PAGE" && typeof r.args?.url === "string" && underSite(r.args.url, site));

  const toolkitOf = (tool) => String(tool).split("_")[0].toLowerCase();
  const now = () => new Date().toISOString();

  const api = {
    // Returns a Composio link the user opens to connect an app (gmail, github, ...).
    // callback_url: where Composio sends the user afterwards (with ?status=success|failed).
    // An app can be connected several times (e.g. work and personal gmail); alias names the connection.
    // mcp_url: a remote MCP server Composio has no toolkit for is added as one first (mcp.js); one that needs no
    // sign-in has no connection to make: { toolkit, no_auth: true }.
    async register_tool({ toolkit, mcp_url, name, api_key_header, callback_url, alias }) {
      let auth;
      if (mcp_url) ({ toolkit, auth } = await addMcpServer({ apiKey: composioApiKey, url: mcp_url, name, api_key_header }));
      if (!toolkit) throw new Error("Pass toolkit (an app's slug) or mcp_url (an MCP server's address)");
      if (auth === "NO_AUTH") return { toolkit, connect_url: null, connection_id: null, no_auth: true, mcp_url: mcpUrl(mcp_url) };
      const configs = await composio.authConfigs.list({ toolkit });
      const authConfigId = configs.items[0]?.id ?? (await newAuthConfig(toolkit));
      const request = await composio.connectedAccounts.link(userId, authConfigId, {
        allowMultiple: true,
        ...(callback_url && { callbackUrl: callback_url }),
        ...(alias && { alias }),
      });
      return { toolkit, connect_url: request.redirectUrl, connection_id: request.id, ...(mcp_url && { mcp_url: mcpUrl(mcp_url) }) };
    },

    // A website as a prepared area: a crawl finds its pages (web.js) and each one is read as a recipe of its own
    // (WEBSITE_READ_PAGE). Again (the host's scheduler, every hour): an unchanged page only moves checked_at, a changed
    // one is described again, a new one is added, and a known page the crawl no longer finds is read again, so one the
    // site removed (404) is marked gone. { url, pages, created, changed, unchanged, failed, complete, scope }.
    async prepare_website({ url, depth, account }) {
      const site = siteUrl(url);
      const crawled = await crawl({ url: site, depth });
      if (!crawled.successful) throw new Error(crawled.error);
      const { pages, complete } = crawled.data;
      const stats = { url: site, pages: pages.length, created: 0, changed: 0, unchanged: 0, failed: 0, complete };
      const read = async (pageUrl) => {
        const out = await api.execute({ tool: "WEBSITE_READ_PAGE", args: { url: pageUrl }, account });
        if (out.created) stats.created++;
        else if (out.changed) stats.changed++;
        else if (out.unchanged) stats.unchanged++;
        else stats.failed++;
      };
      await pool(pages.map((p) => p.url), 4, read);
      if (complete) {
        const found = new Set(pages.map((p) => p.url));
        const missing = (await websitePages(site)).filter((r) => r.status === "fresh" && !found.has(r.args.url)).map((r) => r.args.url);
        missing.forEach(forgetPage);
        await pool(missing, 4, read);
      }
      const scope = scopeStore ? await api.recipes.prepareScope({ label: site, toolkit: "website", account: account ?? "" }) : null;
      if (scope) await scopeStore.put({ ...scope, spec: { kind: "website", url: site, depth: depth ?? null, every: 60, last: { ...stats, at: now() } } });
      return { ...stats, scope: scope?.id ?? null };
    },

    // A website no longer kept: its pages' recipes and its area record go. { url, removed }.
    async forget_website({ url, account }) {
      const site = siteUrl(url);
      const pages = await websitePages(site);
      for (const r of pages) await drop(r.id);
      if (scopeStore) {
        const scope = await api.recipes.prepareScope({ label: site, toolkit: "website", account: account ?? "" });
        await (scopeStore.remove ? scopeStore.remove(scope.id) : null);
      }
      return { url: site, removed: pages.length };
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
    // `connected`: only tools of `apps` (the agent: a tool of an app nobody connected cannot run). Composio's search over
    // all apps gave CLARIFY_MCP_GET_CALENDAR_EVENTS for "What's on my calendar today" with Google Calendar connected,
    // and the agent ran it. So the apps the query means by a word of their name ("calendar") give their tools first,
    // and without one the connected apps' tools are ranked by the query's words.
    async search({ query, limit = 5, apps = [], toolkits: also = [], tools: withTools = false, connected = false }) {
      const english = await translate(query);
      const text = `${query} ${english?.en ?? ""}`;
      const only = connected && apps.length ? new Set(apps.map((a) => String(a).toLowerCase())) : null;
      const toolkits = [...new Set([...also, ...namedApps(text, apps), ...(only ? appsMeant(text, apps) : [])])];
      const vector = await embed(english?.en ? `${query}\n${english.en}` : query, "search_embed").catch(() => null);
      if (vector) askedVectors.set(query, vector);
      if (askedVectors.size > MAX_ASKED) askedVectors.delete(askedVectors.keys().next().value);
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
              ...(r.keywords && { keywords: r.keywords }),
              ...(matched.length && { matched }),
              score: Number(score.toFixed(2)),
              status: r.status,
              updated_at: r.updated_at,
              checked_at: r.checked_at,
              trigger: { active: Boolean(r.trigger?.active) },
            }))
        : [];
      // Skills: pieces found by meaning next to the saved recipes (a piece that is already a recipe is not offered twice).
      if (skills && vector) {
        const have = new Set(memories.map((m) => m.id));
        const pieces = (await skillCandidates(vector, limit).catch(() => [])).filter((p) => !have.has(p.recipe_id));
        memories.push(...pieces);
        memories.sort((a, b) => b.score - a.score);
        memories.splice(limit);
      }
      if (!withTools && memories.some((m) => m.score >= strongScore)) return memories;

      const search = english?.en ?? query;
      const ofApps = (t) => !only || only.has(String(t.toolkit?.slug ?? "").toLowerCase());
      const [own, all, ranked] = await Promise.all([
        toolkits.length ? appToolsFor(toolkits, `${query}\n${english?.en ?? ""}`, vector, Math.max(limit, 8)).catch(() => []) : [],
        // Custom toolkits (MCP servers added by address) are shared by the Composio project: only connected ones.
        composio.tools
          .getRawComposioTools({ search, limit: only ? limit * 4 : limit })
          .then((list) => list.filter((t) => (!isCustomToolkit(t.toolkit?.slug) || apps.includes(t.toolkit.slug)) && ofApps(t)).slice(0, limit))
          .catch((e) => (only ? [] : Promise.reject(e))),
        // No connected app named: the connected apps' tools by the query's words, after Composio's (by meaning).
        only && !toolkits.length
          ? Promise.all([...only].map((app) => toolsOf([app]).catch(() => []))).then((lists) => rankTools(lists.flat(), `${query}\n${english?.en ?? ""}`, limit))
          : [],
      ]);
      const first = [...own, ...all.filter((t) => !own.some((o) => o.slug === t.slug))].slice(0, limit + own.length);
      const tools = [...first, ...ranked.filter((t) => !first.some((o) => o.slug === t.slug))].slice(0, Math.max(limit, first.length));
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
    async execute({ id, tool, args = {}, account, task, remember: keep = true }) {
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
        result = LOCAL[tool]
          ? await LOCAL[tool](withDates(args))
          : await composio.tools.execute(tool, {
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
      // The vector of the request: the one search() computed; on a cache miss (another process, eviction) embedded once here.
      let asked = task ? askedVectors.get(task) : null;
      if (task && !asked) asked = await embed(task, "recipe_embed").catch(() => null);
      // A skill's piece asked for in other words is the same recipe with one more intent key, never a second recipe.
      const intents = (old) => (isSkillTool(tool) ? addIntent(old?.intents, task) : old?.intents);
      // The area the call reads in (a repository, a folder, a calendar), so a project can be offered for it.
      const area = areaOf({ args, data: result.data });
      if (existing && existing.digest === digest && (existing.summary || !openrouterApiKey)) {
        // Same result: nothing is described or embedded again.
        const next = { ...existing, scope: withArea(existing.scope, area), status: "fresh", checked_at: at };
        if (asked) next.queryEmbeddings = addQuery(existing.queryEmbeddings, asked, at);
        if (isSkillTool(tool) && task) next.intents = intents(existing);
        if (asked || (isSkillTool(tool) && task) || existing.status !== "fresh" || existing.checked_at !== at) await save(next);
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
      const record = { ...base, scope: withArea(base.scope, area), digest, status: "fresh", updated_at: at, checked_at: at };
      if (asked) record.queryEmbeddings = addQuery(base.queryEmbeddings, asked, at);
      if (isSkillTool(tool) && task) record.intents = intents(base);
      // The call as it ran: args kept as written (placeholders included), in canonical form so equal calls look equal.
      await save(record);
      if (legacy && legacy.id !== rid) await drop(legacy.id).catch(() => {});
      const described = kept
        ? Promise.resolve(publicRecipe(record))
        : (isSkillTool(tool) ? rememberSkill(rid, digest, result.data) : remember(rid, digest, result.data, { created })).then(publicRecipe);
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

    // Skills (skills.js). The recipes of a skill are tied to a version, and go when the skill goes.
    skills: {
      // The recipes of a skill (any status, newest first), with their intents.
      async recipes({ skill }) {
        return (await everyRecipe())
          .filter((r) => isSkillTool(r.tool) && r.args?.skill === skill)
          .map(publicRecipe)
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      },
      // The skill changed: its recipes of another version are outdated. Each one whose piece (or file) still exists in the
      // new version is made again there (a recipe of the new version, its intent keys and past requests carried over, the
      // old one dropped); the others become gone and stay listed. { carried: [{ from, to }], gone: n }.
      async update({ skill, version }) {
        const now_ = now();
        const current = await skills.get(skill);
        const carried = [];
        let gone = 0;
        for (const r of await everyRecipe()) {
          if (!isSkillTool(r.tool) || r.args?.skill !== skill || r.args?.version === version) continue;
          const key = r.args.chunk ?? r.args.path;
          const exists = current && current.version === version && (r.args.chunk ? current.chunks.some((c) => c.id === key) : current.files.some((f) => f.path === key));
          if (!exists) {
            if (r.status !== "gone") {
              await save({ ...r, status: "gone", checked_at: now_ });
              gone++;
            }
            continue;
          }
          const args = { ...r.args, version };
          const out = await api.execute({ tool: r.tool, args });
          if (out.pending) await out.pending;
          if (!out.id) continue;
          const made = await load(out.id);
          if (made) {
            let intents = made.intents ?? [];
            for (const t of r.intents ?? []) intents = addIntent(intents, t);
            let queries = made.queryEmbeddings ?? [];
            for (const q of r.queryEmbeddings ?? []) queries = addQuery(queries, q.e, q.at);
            await save({ ...made, intents, ...(queries.length && { queryEmbeddings: queries }) });
          }
          await drop(r.id);
          carried.push({ from: r.id, to: out.id });
        }
        return { carried, gone };
      },
      // The skill is deleted: its recipes of every version are deleted with it (a recipe goes with its source). { count }
      async removed({ skill }) {
        let count = 0;
        for (const r of await everyRecipe()) {
          if (!isSkillTool(r.tool) || r.args?.skill !== skill) continue;
          if ((await api.recipes.remove(r.id)).removed) count++;
        }
        return { count };
      },
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

// What a recipe's summary vector is made of: the summary and the search keywords written with it.
const summaryText = ({ summary, keywords }) => (keywords?.length ? `${summary}\nKeywords: ${keywords.join(", ")}` : summary);
const ITEM_DIMS = 256;
// How close a line of a result is to a request (256 dims): «Уборка» to "когда мне убираться" 0.40, to "when should I
// clean" 0.36, to "когда уборка" 0.56; "Стоматолог" to "когда к стоматологу" 0.60; unrelated lines mostly under 0.30,
// a few short ones up to 0.35.
const ITEM_FIT = 0.33;
const ITEM_STRONG = 0.45;
// The requests a recipe answered, as vectors: the one already computed when it was searched, cut like items (256 dims,
// int8), at most MAX_QUERIES, each with how often it came. A near-duplicate (cosine >= QUERY_DUP) only raises the count
// of the stored one; when full, the least frequent and then the oldest goes. No backfill: they pile up from now on.
const MAX_QUERIES = 8;
const QUERY_DUP = 0.95;

// A recipe's scope with the area its last result was in (areaOf), or without one when that call is in none.
const withArea = (scope = {}, area) => {
  const { area: _old, ...rest } = scope ?? {};
  return area ? { ...rest, area } : rest;
};
export function addQuery(list = [], vector, at = new Date().toISOString()) {
  if (!vector?.length) return list;
  const e = Array.from(vector.slice(0, ITEM_DIMS));
  const same = list.findIndex((q) => cosine(e, q.e) >= QUERY_DUP);
  if (same >= 0) return list.map((q, i) => (i === same ? { ...q, n: q.n + 1, at } : q));
  const next = [...list, { e, n: 1, at }];
  if (next.length <= MAX_QUERIES) return next;
  const drop = next.slice(0, -1).reduce((w, q, i, a) => (q.n < a[w].n || (q.n === a[w].n && q.at < a[w].at) ? i : w), 0);
  return next.filter((_, i) => i !== drop);
}
const decrypted = new Map(); // "<user>:<blob prefix>" -> record, shared by every genter in the process
const translations = new Map(); // query -> Promise<{ en, terms } | null>

// Embeddings are stored as base64 float32 (8 KB instead of ~30 KB of JSON numbers each); older records keep arrays.
const VECTORS = ["summaryEmbedding"];
// A result's item vectors are int8 (1.5 KB each; cosine does not care about their scale).
function pack(record) {
  const out = { ...record };
  for (const key of VECTORS) if (out[key]) out[key] = toB64(out[key]);
  if (out.itemEmbeddings) out.itemEmbeddings = out.itemEmbeddings.map(toI8);
  if (out.queryEmbeddings) out.queryEmbeddings = out.queryEmbeddings.map((q) => ({ ...q, e: toI8(q.e) }));
  return out;
}
function unpack(record) {
  for (const key of VECTORS) if (typeof record[key] === "string") record[key] = fromB64(record[key]);
  if (record.itemEmbeddings) record.itemEmbeddings = record.itemEmbeddings.map(fromI8);
  if (record.queryEmbeddings) record.queryEmbeddings = record.queryEmbeddings.map((q) => ({ ...q, e: fromI8(q.e) }));
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

// Connected apps the text means by a word of their name or what they hold, not their whole slug: "calendar" or
// "meetings" -> googlecalendar, "my drive" -> googledrive. Only for finding tools: a recipe of another app still counts.
export function appsMeant(text, apps = []) {
  const stem = (w) => w.replace(/(ies|es|s)$/, "");
  const words = new Set(String(text).toLowerCase().split(/[^a-z0-9а-яё]+/).filter(Boolean).map(stem));
  return [...new Set(apps)].filter((slug) => {
    const s = String(slug ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const rest = s.replace(/^(google|microsoft|ms|zoho|atlassian|amazon|aws)/, "");
    const names = [...(rest.length >= 4 && rest !== s ? [rest] : []), ...(APP_WORDS[s] ?? [])];
    return names.some((n) => words.has(stem(n)));
  });
}
// What people call an app's data instead of the app (English and Russian).
const APP_WORDS = {
  googlecalendar: ["meeting", "event", "schedule", "agenda", "календарь", "календаре", "встреча", "встречи", "событие", "события"],
  gmail: ["email", "mail", "inbox", "почта", "почте", "письма", "письмо"],
};

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

// fn over items, n at a time.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
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
