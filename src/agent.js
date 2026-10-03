import { randomUUID } from "node:crypto";
import { cipher } from "./genter.js";

// The task agent: an LLM loop over genter (search -> execute -> save), tuned for speed.
// Before the first LLM call it already has, in parallel: the saved recipes matching the task (found by
// what they do and by what they returned), candidate Composio tools with compact arg schemas, and the
// connected apps. So a known task is usually one tool call and an answer, and a recipe's result summary
// can answer a question with no tool call at all.
// A run can pause (a question for the user, an app to connect) and be continued with `send`.
// Runs are stored encrypted: { id, blob }. Tool results are kept only as their summaries, never raw.
//
// mode "run": do the task. mode "find": read-only, only tools that read data run.
// canExecute false: no tool runs at all (dashboard viewers); the agent answers from recipes and plans.
export function createAgent({
  genter,
  openrouterApiKey,
  secret,
  userId,
  runs, // get(id) -> { blob } | undefined, put({ id, blob })
  model = process.env.AGENT_MODEL || "openai/gpt-oss-20b",
  maxSteps = 12,
  canExecute = true,
  canConnect = true,
  onEvent = () => {},
}) {
  if (!openrouterApiKey) throw new Error("The agent needs an OpenRouter key (OPENROUTER_API_KEY)");
  const { seal, open } = cipher(`${secret}:${userId}:runs`);

  async function llm(messages, usage) {
    const started = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        provider: { sort: process.env.OPENROUTER_SORT || "throughput" }, // the fastest provider for the model
        // The system prompt and tool list never change, so providers can cache this prefix.
        messages: [{ role: "system", content: SYSTEM }, ...messages.map(({ keep, ...m }) => m)],
        tools: TOOLS,
        parallel_tool_calls: true,
        temperature: 0,
        reasoning: { effort: "low" }, // the fast agent: short thinking, quick tool calls
        usage: { include: true },
      }),
    });
    if (!res.ok) throw new Error(`Agent model failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    usage.llm_calls += 1;
    usage.tokens_in += data.usage?.prompt_tokens ?? 0;
    usage.tokens_out += data.usage?.completion_tokens ?? 0;
    usage.cost_usd += data.usage?.cost ?? 0;
    usage.llm_ms += Date.now() - started;
    return data.choices[0].message;
  }

  // One tool call from the model. Returns { content, keep?, pause? }:
  // content goes back to the model now, keep is what is stored instead (no raw results), pause stops the run.
  async function call(run, name, input) {
    switch (name) {
      case "search_tools": {
        const found = await genter.search({ query: input.query, limit: 6 });
        return { content: JSON.stringify(found.map(compactFound)) };
      }
      case "get_tool_schema": {
        const schemas = await Promise.all((input.tools ?? []).slice(0, 5).map((slug) => genter.schema(slug).catch((e) => ({ tool: slug, error: e.message }))));
        return { content: JSON.stringify(schemas) };
      }
      case "execute": {
        if (!canExecute) return { content: "Not allowed: this user can search but not run tools. Answer from recipes, or say which tool would do it." };
        const tool = input.tool ?? run.recipes[input.id];
        if (run.mode === "find" && tool && !isReadOnly(tool)) {
          return { content: `Not allowed: ${tool} changes data and this is a read-only find. Only read, or tell the user to use run_task.` };
        }
        const started = Date.now();
        const out = await genter.execute({ ...input, account: input.account ?? run.account }).catch((e) => ({ thrown: e.message }));
        run.timing.tool_ms += Date.now() - started;
        // A slug that does not exist: answer with real ones right away instead of spending a step on search_tools.
        const error = out.thrown ?? (out.result?.successful === false ? out.result?.error : null);
        if (error && tool && /not found|does not exist|invalid tool|unknown tool|no tool/i.test(String(error))) {
          const similar = await genter.search({ query: tool.toLowerCase().replace(/_/g, " "), limit: 5 }).catch(() => []);
          onEvent({ type: "tool", tool, ok: false, summary: "no such tool" });
          return { content: JSON.stringify({ error: `${tool} does not exist`, use_one_of: similar.map(compactFound) }) };
        }
        if (out.thrown) throw new Error(out.thrown);
        const ok = out.result?.successful !== false;
        const data = ok ? (out.result?.data ?? null) : null;
        const empty = ok && isEmpty(data);
        run.steps.push({ tool: tool ?? input.id, recipe: input.id ?? null, ok, summary: out.summary ?? null, saved: out.id ?? null });
        onEvent({ type: "tool", tool: tool ?? input.id, recipe: input.id ?? null, ok, empty, summary: out.summary ?? (empty ? "nothing found" : null) });
        if (out.id) run.recipes[out.id] = tool;
        // An empty search is not an answer yet: the words may be in another language than the data, or too narrow.
        const retry =
          empty && !run.retried
            ? ((run.retried = true),
              "Empty result. Do not answer 'not found' yet: retry once with the key terms in both languages joined with OR " +
                "(the data is often in English when the user writes in another language, and the other way round), " +
                "plus close synonyms, fewer words and no date filter.")
            : undefined;
        const short = { id: out.id, successful: ok, summary: out.summary ?? undefined, error: ok ? undefined : out.result?.error, hint: retry ?? out.hint };
        const text = ok ? JSON.stringify(data) : "";
        return {
          content: JSON.stringify({ ...short, data: text.length > 10000 ? `${text.slice(0, 10000)}… (truncated)` : text || undefined }),
          keep: JSON.stringify({ ...short, note: "raw data not stored; execute this id again for details" }),
        };
      }
      case "search_knowledge": {
        const hits = await genter.knowledge({ query: input.query, limit: 8, source: input.source });
        return { content: JSON.stringify(hits.map(compactHit)) };
      }
      case "add_source": {
        if (!genter.sources) return { content: "Sources are not available here." };
        if (!canExecute) return { content: "Not allowed: this user can search but not add sources." };
        const account = input.account ?? run.account;
        let scope = input.scope ?? {};
        // "genter-cli", "Roadmap": picked from what the connection has, so nobody needs owner/repo or page ids.
        if (input.pick && !Object.keys(scope).length) {
          const all = await genter.sources.choices({ template: input.template, account });
          const want = input.pick.toLowerCase().trim();
          const exact = all.filter((c) => c.label.toLowerCase() === want || c.label.toLowerCase().endsWith(`/${want}`));
          const found = exact.length ? exact : all.filter((c) => c.label.toLowerCase().includes(want));
          if (found.length !== 1) {
            return {
              content: JSON.stringify({
                error: found.length ? `Several match "${input.pick}"` : `Nothing matches "${input.pick}"`,
                choices: (found.length ? found : all).slice(0, 15).map((c) => c.label),
                hint: "Ask the user which one (ask_user), or call add_source again with the exact name.",
              }),
            };
          }
          scope = found[0].scope;
        }
        const source = await genter.sources.create({ template: input.template, scope, depth: input.depth, account });
        onEvent({ type: "step", tool: "sync_source", input: { source: source.title } });
        const synced = await genter.sources.sync({ id: source.id, budgetMs: 60000 });
        let watching = synced.watching;
        let watchError;
        if (input.watch !== false && genter.sources.watch) {
          const watched = await genter.sources.watch({ id: source.id }).catch((e) => ({ watch_error: e.message }));
          watching = watched.watching ?? [];
          watchError = watched.watch_error;
        }
        onEvent({ type: "tool", tool: "sync_source", ok: synced.status !== "failed", summary: syncText(synced) });
        const note = `${syncText(synced)}${watching?.length ? ` Kept up to date ${watching.join(", ")}.` : ""}${watchError ? ` Auto-update could not be turned on: ${watchError}` : ""}`;
        return { content: JSON.stringify({ ...synced, watching, note }) };
      }
      case "sync_source": {
        if (!genter.sources) return { content: "Sources are not available here." };
        if (!canExecute) return { content: "Not allowed: this user can search but not sync sources." };
        const synced = await genter.sources.sync({ id: input.id, budgetMs: 60000 });
        onEvent({ type: "tool", tool: "sync_source", ok: synced.status !== "failed", summary: syncText(synced) });
        return { content: JSON.stringify({ ...synced, note: syncText(synced) }) };
      }
      case "save_recipes": {
        const saved = await genter.save_recipes({ recipes: input.recipes ?? [] });
        return { content: JSON.stringify(saved.map(({ id, status }) => ({ id, status }))) };
      }
      case "connect_app": {
        if (!canConnect) {
          return { content: "", pause: { status: "needs_connection", toolkit: input.toolkit, answer: `${input.toolkit} is not connected. Ask a workspace admin to connect it.` } };
        }
        const { connect_url } = await genter.register_tool({ toolkit: input.toolkit, alias: input.alias });
        return {
          content: `Connection link created for ${input.toolkit}.`,
          pause: { status: "needs_connection", toolkit: input.toolkit, connect_url, answer: `Connect ${input.toolkit}: ${connect_url} — then continue this run.` },
        };
      }
      case "ask_user":
        return { content: "Asked the user; their reply comes as the next message.", pause: { status: "needs_input", question: input.question, answer: input.question } };
      default:
        return { content: `Unknown tool ${name}` };
    }
  }

  async function loop(run) {
    const started = Date.now();
    const usage = { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, llm_ms: 0 };
    run.timing = { search_ms: run.timing?.search_ms ?? 0, tool_ms: 0 };
    let result = null;
    try {
      for (let step = 0; step < maxSteps && !result; step++) {
        const message = await llm(run.messages, usage);
        run.messages.push({ role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length && { tool_calls: message.tool_calls }) });
        if (!message.tool_calls?.length) {
          result = { status: "done", answer: message.content ?? "" };
          break;
        }
        // Independent calls run in parallel, like the model asked.
        const outs = await Promise.all(
          message.tool_calls.map(async (tc) => {
            let input = {};
            try {
              input = JSON.parse(tc.function.arguments || "{}");
            } catch {
              return { tc, out: { content: "Invalid JSON arguments" } };
            }
            onEvent({ type: "step", tool: tc.function.name, input: tc.function.name === "execute" ? { tool: input.tool, id: input.id } : input });
            const out = await call(run, tc.function.name, input).catch((e) => ({ content: `Error: ${e.message}` }));
            return { tc, out };
          }),
        );
        for (const { tc, out } of outs) {
          run.messages.push({ role: "tool", tool_call_id: tc.id, content: out.content || "ok", ...(out.keep && { keep: out.keep }) });
        }
        const pause = outs.find((o) => o.out.pause)?.out.pause;
        if (pause) result = pause;
      }
      result ??= { status: "failed", answer: `Stopped after ${maxSteps} steps without an answer.` };
    } catch (error) {
      result = { status: "failed", answer: error.message };
    }
    run.status = result.status;
    run.updated_at = new Date().toISOString();
    // Stored without raw tool results: each one is replaced by its summary.
    const stored = { ...run, timing: undefined, messages: run.messages.map(({ keep, ...m }) => (keep ? { ...m, content: keep } : m)) };
    await runs.put({ id: run.id, blob: seal(stored) });
    const out = {
      run_id: run.id,
      ...result,
      steps: run.steps,
      usage: { ...usage, ...run.timing, cost_usd: Number(usage.cost_usd.toFixed(5)), ms: Date.now() - started + (run.timing.search_ms || 0) },
    };
    onEvent({ type: "done", result: out });
    return out;
  }

  return {
    // Start a task. Recipes, candidate tools and connections are fetched in parallel before the first LLM call.
    async start({ task, mode = "run", account }) {
      onEvent({ type: "step", tool: "search_recipes", input: { query: task } });
      const searched = Date.now();
      const [found, connected, english, sources, knowledge] = await Promise.all([
        genter.search({ query: task, limit: 8 }).catch(() => []),
        genter.login().then((l) => l.connected ?? []).catch(() => []),
        genter.translate ? genter.translate(task) : null, // shared with search, so no second model call
        genter.sources ? genter.sources.list().catch(() => []) : [],
        genter.knowledge ? genter.knowledge({ query: task, limit: 6 }).catch(() => []) : [],
      ]);
      const search_ms = Date.now() - searched;
      const recipes = found.filter((r) => r.id);
      onEvent({ type: "recipes", recipes: recipes.map(({ id, tool, description, short, summary, score, status, tags, when, args }) => ({ id, tool, description, short, summary, score, status, tags, when, args })) });
      const run = {
        id: randomUUID(),
        task,
        mode,
        account,
        status: "running",
        created_at: new Date().toISOString(),
        recipes: Object.fromEntries(recipes.map((r) => [r.id, r.tool])),
        steps: [],
        timing: { search_ms },
        messages: [{ role: "user", content: briefing({ task, mode, account, found, connected, canExecute, english, sources, knowledge }) }],
      };
      return loop(run);
    },

    // Continue a run: answer its question, say an app is connected, correct it, or give the next instruction.
    async send({ run_id, message }) {
      const row = await runs.get(run_id);
      if (!row) throw new Error(`Unknown run_id: ${run_id}`);
      const run = open(row.blob);
      run.steps = [];
      run.messages.push({ role: "user", content: message });
      return loop(run);
    },
  };
}

// Tools that only read: by Composio's hint, or by the verb in the slug.
export function isReadOnly(tool, tags = []) {
  if (tags.includes("readOnlyHint")) return true;
  const slug = tool.toUpperCase();
  if (/_(SEND|CREATE|DELETE|REMOVE|UPDATE|PATCH|POST|REPLY|FORWARD|MOVE|ARCHIVE|TRASH|ADD|INSERT|UPLOAD|SET|INVITE|MERGE|CLOSE|PUBLISH|SHARE|EXECUTE|RUN|START|STOP|CANCEL)(_|$)/.test(slug)) return false;
  return /_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|DESCRIBE|VIEW|COUNT|CHECK|LOOKUP|EXPORT|DOWNLOAD)(_|$)/.test(slug);
}

// A result with lists, all of them empty: a search that found nothing. A single object counts as found.
export function isEmpty(data) {
  let lists = 0;
  let items = 0;
  const walk = (v, depth) => {
    if (depth > 4 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      lists++;
      items += v.length;
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return lists > 0 && items === 0;
}

// Search results as the model sees them: recipes in full, Composio tools with a compact arg schema.
function compactFound(r) {
  if (r.id) {
    return { id: r.id, tool: r.tool, args: r.args, description: r.description, result_summary: r.summary, when: r.when, status: r.status, score: r.score };
  }
  return { tool: r.tool, description: (r.description ?? "").slice(0, 300), args: compactSchema(r.args) };
}

function compactSchema(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.fromEntries(
    Object.entries(props).map(([key, p]) => [
      key,
      `${p.type ?? "any"}${required.has(key) ? "" : "?"}${p.description ? ` — ${p.description.slice(0, 100)}` : ""}`,
    ]),
  );
}

// A knowledge chunk as the model sees it.
const compactHit = (h) => ({ source: h.source_title, title: h.title, url: h.url, score: h.score, text: h.text.slice(0, 1200) });

const syncText = (s) =>
  s.status === "failed"
    ? `Sync failed: ${s.last_run?.error ?? "unknown error"}`
    : `${s.title}: ${s.stats.items} items, ${s.stats.chunks} chunks` +
      (s.last_run ? ` (+${s.last_run.added} new, ${s.last_run.updated} updated, ${s.last_run.removed} removed${s.last_run.failed ? `, ${s.last_run.failed} failed` : ""})` : "") +
      (s.status === "partial" ? `; ${s.last_run?.left ?? "some"} items left — it continues on the next sync (dashboard → Sources, or sync_source).` : "");

const TEMPLATE_HELP =
  'Templates: github — files of a repository; notion — a page and every page under it, or all pages shared with Genter. ' +
  "Pass pick (the repo or page name as the user said it) or scope. It is kept up to date on every change unless watch is false. " +
  'depth: "titles" (names and links only, fast), "summary" (a short summary per item), "full" (whole text, default).';

function briefing({ task, mode, account, found, connected, canExecute, english, sources = [], knowledge = [] }) {
  const recipes = found.filter((r) => r.id).map(compactFound);
  const tools = found.filter((r) => !r.id).map(compactFound);
  const apps = connected.map((c) => `${c.toolkit}${c.alias ? ` (${c.alias}${c.default ? ", default" : ""})` : ""}${c.status && c.status !== "ACTIVE" ? ` [${c.status}]` : ""}`);
  return [
    `Task: ${task}`,
    english?.en && `In English: ${english.en}`,
    english?.terms?.length && `Search terms for keyword filters (use both languages, joined with OR): ${english.terms.join(" | ")}`,
    mode === "find" ? "Mode: find (read-only: answer the question; only execute tools that read data)." : "Mode: run (do the task).",
    !canExecute && "This user cannot run tools: answer from recipe summaries, or say which tool and args would do it.",
    account && `Use connection: ${account}`,
    `Connected apps: ${apps.join(", ") || "none"}`,
    `Saved recipes matching the task (best first):\n${recipes.length ? JSON.stringify(recipes) : "none"}`,
    tools.length && `Candidate Composio tools:\n${JSON.stringify(tools)}`,
    sources.length && `Synced sources: ${JSON.stringify(sources.map((s) => ({ id: s.id, title: s.title, toolkit: s.toolkit, depth: s.depth, status: s.status, items: s.stats.items, synced_at: s.synced_at })))}`,
    knowledge.length && `Knowledge from synced sources matching the task (best first):\n${JSON.stringify(knowledge.map(compactHit))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SYSTEM = `You are Genter's task agent. You act in the user's connected apps through Composio tools, and you are judged on speed: the fewest steps that give a correct, complete result.

The first message already holds everything for a fast start: saved recipes that match the task (proven past calls with their args and a summary of what they returned), candidate Composio tools with their args, and the connected apps.
- If a recipe's result_summary or the knowledge from synced sources already answers the question, answer right away without calling anything; cite the titles and links.
- Synced sources are an app's content kept searchable (a GitHub repo, Notion pages). Use search_knowledge for more of it. When the user asks to remember, index or keep an app's content up to date, call add_source; to refresh one, sync_source.
- If a recipe fits, execute it by id and override only the args that differ. This is the fastest path.
- Otherwise pick a candidate tool and execute it. Call get_tool_schema only when the args are unclear; call search_tools only when nothing fits.
- Make independent calls in the same step (parallel). Chain only when a call needs another's output.
- Never invent tool slugs or argument names: use only slugs from the first message, search results or error hints.
- Keyword search in apps (Gmail q, Slack, Drive, Notion, GitHub search) matches literal words, and the data is often in another language than the request (English emails, Russian request). Put the key terms in both languages in one query, joined with OR, e.g. Gmail: ("объединенные знания" OR "unified knowledge" OR "merged knowledge"). The first message lists the terms.
- An empty result is not an answer: retry once with translated or broader terms before saying nothing was found.
- When you execute a tool that did not come from a recipe and it is a reusable step, pass description, short and tags so the next run finds it:
  description is a general Markdown recipe: "### <Verb> <object>", a line "\`TOOL_SLUG\` · args: \`{a, b?}\`", what it returns, how to reuse it, "- pitfall: ..." bullets; short is one line under 100 characters for lists; tags in English and Russian.
- If a recipe returned something different from its description, save it again with status "outdated" (save_recipes) and say why.
- An app the task needs is not connected: call connect_app and stop.
- The task is ambiguous in a way that matters (which person, which account, an irreversible action on an unclear target): call ask_user with one short question. Otherwise do not ask; pick the sensible default.
- An app is connected several times: pass account (alias or id) when the user names one; otherwise the default is used.
Final answer: short and concrete, in the user's language. Include the names, ids and links needed to open or continue the result. Say what was done, not how.`;

const recipeFields = {
  description: { type: "string", description: "General Markdown recipe for this call (see instructions)" },
  short: { type: "string", description: "One line under 100 characters for compact lists, e.g. 'Fetch unread emails from the inbox'" },
  tags: { type: "array", items: { type: "string" }, description: "Tags in English and Russian" },
};

const TOOLS = [
  {
    name: "execute",
    description: "Run a Composio tool: `tool` + `args`, or `id` of a saved recipe (args override its args). Returns the result data, a summary and the recipe id it was saved as.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved recipe id" },
        tool: { type: "string", description: "Tool slug, e.g. GMAIL_FETCH_EMAILS" },
        args: { type: "object", additionalProperties: true },
        account: { type: "string", description: "Connection alias or id when the app is connected several times" },
        ...recipeFields,
      },
    },
  },
  {
    name: "search_tools",
    description: "Search saved recipes (by what they do and what they returned) and Composio tools. Only when nothing in the first message fits.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_tool_schema",
    description: "Full argument schemas for up to 5 tool slugs.",
    parameters: { type: "object", properties: { tools: { type: "array", items: { type: "string" } } }, required: ["tools"] },
  },
  {
    name: "save_recipes",
    description: "Improve recipe descriptions or mark one outdated.",
    parameters: {
      type: "object",
      properties: {
        recipes: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, ...recipeFields, status: { type: "string", enum: ["valid", "outdated"] } },
            required: ["id", "description"],
          },
        },
      },
      required: ["recipes"],
    },
  },
  {
    name: "search_knowledge",
    description: "Search the synced sources (repos, Notion pages) by meaning. Returns the closest text chunks with titles and links.",
    parameters: { type: "object", properties: { query: { type: "string" }, source: { type: "string", description: "Only this source id" } }, required: ["query"] },
  },
  {
    name: "add_source",
    description: `Remember an app's content as searchable knowledge and sync it now (a large one continues on later syncs). ${TEMPLATE_HELP}`,
    parameters: {
      type: "object",
      properties: {
        template: { type: "string", enum: ["github", "notion"] },
        pick: { type: "string", description: "Name of the repo or top-level page as the user said it, e.g. genter-cli or Roadmap; found among the connection's repos/pages" },
        scope: { type: "object", additionalProperties: true, description: "Template fields when known exactly, e.g. {owner, repo}" },
        watch: { type: "boolean", description: "Keep it up to date on every change (default true)" },
        depth: { type: "string", enum: ["titles", "summary", "full"] },
        account: { type: "string", description: "Connection alias or id when the app is connected several times" },
      },
      required: ["template"],
    },
  },
  {
    name: "sync_source",
    description: "Bring a synced source up to date: only new and changed items are read.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "connect_app",
    description: "Create a link for the user to connect an app (toolkit slug like gmail, github, slack). Stops the run until they connect it.",
    parameters: { type: "object", properties: { toolkit: { type: "string" }, alias: { type: "string" } }, required: ["toolkit"] },
  },
  {
    name: "ask_user",
    description: "Ask the user one short question and stop until they reply.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
].map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));
