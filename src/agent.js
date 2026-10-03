import { randomUUID } from "node:crypto";
import { cipher, namedApps } from "./genter.js";
import { createBuilder } from "./builder.js";

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
  // A task no saved recipe covers yet, or a run the fast model gets stuck on, goes to a stronger model.
  // What it finds becomes recipes, so the next time the same task runs on the fast one.
  strongModel = process.env.AGENT_STRONG_MODEL || process.env.BUILDER_MODEL || "openai/gpt-6-luna",
  maxSteps = 12,
  canExecute = true,
  canConnect = true,
  onEvent = () => {},
}) {
  if (!openrouterApiKey) throw new Error("The agent needs an OpenRouter key (OPENROUTER_API_KEY)");
  const { seal, open } = cipher(`${secret}:${userId}:runs`);
  const builder = genter.sources && genter.save_live_sync ? createBuilder({ genter, openrouterApiKey, onEvent }) : null;
  let lastNote = null;
  let currentRun = {};

  // A source made, synced (one round) and kept up to date; the note says it all for the model.
  async function addSource({ template, scope, depth, filter, account, watch }) {
    const source = await genter.sources.create({ template, scope, depth, filter, account });
    onEvent({ type: "step", tool: "sync_source", input: { source: source.title } });
    const synced = await genter.sources.sync({ id: source.id, budgetMs: 60000 });
    let watching = synced.watching;
    let watchError;
    if (watch !== false && genter.sources.watch) {
      const watched = await genter.sources.watch({ id: source.id }).catch((e) => ({ watch_error: e.message }));
      watching = watched.watching ?? [];
      watchError = watched.watch_error;
    }
    onEvent({ type: "tool", tool: "sync_source", ok: synced.status !== "failed", summary: syncText(synced) });
    const note = `${syncText(synced)}${watching?.length ? ` Kept up to date ${watching.join(", ")}.` : ""}${watchError ? ` Auto-update could not be turned on: ${watchError}` : ""}`;
    lastNote = note;
    if (synced.status !== "failed") currentRun.sourced = true;
    return { ...synced, watching, note };
  }

  async function llm(messages, usage, tools = TOOLS, toolChoice, useModel = model) {
    const started = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        provider: { sort: process.env.OPENROUTER_SORT || "throughput" }, // the fastest provider for the model
        // The system prompt and tool list never change, so providers can cache this prefix.
        messages: [{ role: "system", content: SYSTEM }, ...messages.map(({ keep, ...m }) => m)],
        tools,
        parallel_tool_calls: true,
        ...(toolChoice && { tool_choice: toolChoice }),
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
        // A model that keeps searching instead of running something: after a few searches it must execute.
        run.searches = (run.searches ?? 0) + 1;
        if (run.searches > MAX_SEARCHES) {
          return { content: JSON.stringify({ error: "No more searching.", hint: `Execute now the closest tool you already have: ${[...(run.seen ?? [])].slice(0, 8).join(", ")}. Then answer.` }) };
        }
        const found = await genter.search({ query: input.query, limit: 6, apps: run.apps, toolkits: run.named });
        run.seen = new Set([...(run.seen ?? []), ...found.filter((f) => f.tool).slice(0, 4).map((f) => f.tool)]);
        const hint = run.searches >= 2 ? "Pick the closest tool above and execute it now; do not search again." : undefined;
        return { content: JSON.stringify(hint ? { tools: found.map(compactFound), hint } : found.map(compactFound)) };
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
        // A call that already failed is not run again: the model gets the error back and must change course.
        const key = `${tool ?? input.id} ${JSON.stringify(input.args ?? {})}`;
        const failed = run.failed[key];
        if (failed) {
          onEvent({ type: "tool", tool: tool ?? input.id, ok: false, summary: "same call failed before, not repeated" });
          return { content: JSON.stringify({ error: `This exact call already failed: ${failed}`, hint: "Do not repeat it. Change the args, use another tool, or answer with what you have." }) };
        }
        if (tool && (run.failures[tool] ?? 0) >= MAX_TOOL_FAILURES) {
          onEvent({ type: "tool", tool, ok: false, summary: `failed ${MAX_TOOL_FAILURES} times, not run again` });
          return { content: JSON.stringify({ error: `${tool} failed ${MAX_TOOL_FAILURES} times in this run and is not run again.`, hint: "Answer with what you have and say what did not work." }) };
        }
        run.failed[key] = "the same call is already running"; // parallel duplicates in one step run once
        const started = Date.now();
        const out = await genter.execute({ ...input, account: input.account ?? run.account }).catch((e) => ({ thrown: e.message }));
        run.timing.tool_ms += Date.now() - started;
        const error = out.thrown ?? (out.result?.successful === false ? out.result?.error : null);
        if (error) {
          run.failed[key] = String(typeof error === "string" ? error : JSON.stringify(error)).slice(0, 300);
          if (tool) run.failures[tool] = (run.failures[tool] ?? 0) + 1;
        } else delete run.failed[key];
        // A slug that does not exist: answer with real ones right away instead of spending a step on search_tools.
        // "Not Found" is also what an app says about a repo, file or id that does not exist: only a slug Composio
        // does not know is a missing tool, otherwise the model drops a working tool or retries it forever.
        if (error && tool && /not found|does not exist|invalid tool|unknown tool|no tool/i.test(String(error)) && !(await genter.schema(tool).then(() => true, () => false))) {
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
        const missing = !ok && /not found|404|does not exist/i.test(String(JSON.stringify(out.result?.error ?? "")))
          ? "What these args point to does not exist (wrong owner, repo, path or id?). Do not guess again: find the real name with a list or search tool first, or answer without it."
          : undefined;
        const short = { id: out.id, successful: ok, summary: out.summary ?? undefined, error: ok ? undefined : out.result?.error, hint: retry ?? missing ?? out.hint };
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
                hint: "Do not ask: call add_source again with the exact name of the closest choice; if none fits, say so in the answer with the choices.",
              }),
            };
          }
          scope = found[0].scope;
        }
        return { content: JSON.stringify(await addSource({ template: input.template, scope, depth: input.depth, filter: input.filter, account, watch: input.watch })) };
      }
      case "build_live_sync": {
        if (!builder) return { content: "Building live sync recipes is not available here." };
        if (!canExecute) return { content: "Not allowed: this user can search but not add sources." };
        const account = input.account ?? run.account;
        const built = await builder.build({ goal: input.goal, toolkit: input.toolkit, account });
        run.usage_extra = (run.usage_extra ?? 0) + (built.cost ?? 0);
        run.calls_extra = (run.calls_extra ?? 0) + (built.steps ?? 0);
        onEvent({ type: "tool", tool: "build_live_sync", ok: built.saved, summary: built.saved ? `recipe ${built.id}` : built.answer });
        if (!built.saved) return { content: JSON.stringify({ error: built.answer }) };
        const source = await addSource({ template: built.id, scope: built.scope, depth: input.depth, filter: input.filter, account, watch: input.watch });
        return { content: JSON.stringify({ recipe: built.id, ...source, note: `New live sync recipe saved (${built.id}). ${source.note}` }) };
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
      default:
        return { content: `Unknown tool ${name}` };
    }
  }

  async function loop(run) {
    const started = Date.now();
    const usage = { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, llm_ms: 0 };
    run.timing = { search_ms: run.timing?.search_ms ?? 0, tool_ms: 0 };
    lastNote = null;
    currentRun = run;
    run.sourced = false;
    run.nudged = false;
    run.searches = 0;
    run.seen = new Set();
    run.failed = {}; // "<tool> <args>" -> error of a call that failed in this round
    run.failures = {}; // tool -> failed calls in this round
    let result = null;
    try {
      for (let step = 0; step < maxSteps && !result; step++) {
        // A remember/keep-up-to-date task gets only the source tools: no one-off execute instead of a source.
        // Once the source is added there is nothing left to call: only the answer.
        // A question or a one-off task never adds sources: without these the model reads the data instead.
        // Stuck on the fast model (failed calls, searching again and again): the rest of the run goes to the strong one.
        if (!run.strong && (Object.keys(run.failures).length || run.searches >= 2 || run.nudged || run.retried)) run.strong = true;
        const message = await llm(run.messages, usage, run.sync && builder ? SYNC_TOOLS : run.sync ? TOOLS : TASK_TOOLS, run.sourced ? "none" : undefined, run.strong ? strongModel : model);
        run.messages.push({ role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length && { tool_calls: message.tool_calls }) });
        if (!message.tool_calls?.length) {
          // An answer that is a question for the user: once, it is sent back to do the task instead.
          if (ASKS.test(message.content ?? "") && !run.nudged && step < maxSteps - 2 && !run.sourced) {
            run.nudged = true;
            run.messages.push({ role: "user", content: NO_QUESTIONS });
            continue;
          }
          // A model that ends without text: the last tool note is the answer.
          result = { status: "done", answer: message.content?.trim() || lastNote || "Done." };
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
            onEvent({ type: "step", tool: tc.function.name, input: tc.function.name === "execute" ? { tool: input.tool ?? run.recipes[input.id], id: input.id } : input });
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
      // Out of steps: one more call with no tools, so the user gets an answer from what was found.
      if (!result) {
        run.messages.push({ role: "user", content: "No more tool calls. Answer now from what you found; say briefly what is missing." });
        const message = await llm(run.messages, usage, TOOLS, "none", run.strong ? strongModel : model).catch(() => null);
        run.messages.push({ role: "assistant", content: message?.content ?? null });
        result = message?.content?.trim()
          ? { status: "done", answer: message.content.trim() }
          : { status: "failed", answer: `Stopped after ${maxSteps} steps without an answer.` };
      }
    } catch (error) {
      result = { status: "failed", answer: error.message };
    }
    usage.cost_usd += run.usage_extra ?? 0; // the live sync builder's model: its steps are credits too
    usage.llm_calls += run.calls_extra ?? 0;
    run.usage_extra = 0;
    run.calls_extra = 0;
    run.status = result.status;
    run.updated_at = new Date().toISOString();
    // Stored without raw tool results: each one is replaced by its summary.
    const stored = { ...run, timing: undefined, seen: undefined, messages: run.messages.map(({ keep, ...m }) => (keep ? { ...m, content: keep } : m)) };
    await runs.put({ id: run.id, blob: seal(stored) });
    const out = {
      run_id: run.id,
      ...result,
      steps: run.steps,
      usage: { ...usage, ...run.timing, model: run.strong ? strongModel : model, cost_usd: Number(usage.cost_usd.toFixed(5)), ms: Date.now() - started + (run.timing.search_ms || 0) },
    };
    onEvent({ type: "done", result: out });
    return out;
  }

  return {
    // Start a task. Recipes, candidate tools and connections are fetched in parallel before the first LLM call.
    async start({ task, mode = "run", account }) {
      onEvent({ type: "step", tool: "search_recipes", input: { query: task } });
      const searched = Date.now();
      const connecting = genter.login().then((l) => l.connected ?? []).catch(() => []);
      let [found, connected, english, sources, knowledge] = await Promise.all([
        connecting.then((c) => genter.search({ query: task, limit: 8, apps: c.map((x) => x.toolkit) })).catch(() => []),
        connecting,
        genter.translate ? genter.translate(task) : null, // shared with search, so no second model call
        genter.sources ? genter.sources.list().catch(() => []) : [],
        genter.knowledge ? genter.knowledge({ query: task, limit: 8 }).catch(() => []) : [],
      ]);
      const search_ms = Date.now() - searched;
      // The apps the task names: recipes of other apps are left out ("what's new in Google Tasks" is not a Gmail search).
      const named = namedApps(`${task} ${english?.en ?? ""}`, connected.map((c) => c.toolkit));
      const ofNamed = (r) => !named.length || !r.tool || named.some((t) => r.tool.startsWith(`${t.toUpperCase()}_`));
      found = found.filter(ofNamed);
      const recipes = found.filter((r) => r.id);
      onEvent({ type: "recipes", recipes: recipes.map(({ id, tool, description, short, summary, score, status, tags, when, args }) => ({ id, tool, description, short, summary, score, status, tags, when, args })) });
      const run = {
        id: randomUUID(),
        task,
        mode,
        sync: mode === "run" && canExecute && SYNC_INTENT.test(task),
        account,
        status: "running",
        created_at: new Date().toISOString(),
        apps: [...new Set(connected.map((c) => c.toolkit))],
        // No valid recipe that clearly fits: this task is new, the strong model works it out (and leaves recipes).
        strong: !recipes.some((r) => r.status !== "outdated" && r.score >= STRONG_RECIPE),
        named, // apps the task is about
        recipes: Object.fromEntries(recipes.map((r) => [r.id, r.tool])),
        steps: [],
        timing: { search_ms },
        messages: [{ role: "user", content: briefing({ task, mode, account, found, connected, canExecute, english, sources, knowledge, named }) }],
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
  if (r.kind === "sync") {
    // A sync recipe's result is kept as embeddings: read it with search_knowledge, or sync it first.
    return {
      id: r.id,
      kind: "sync",
      toolkit: r.toolkit,
      description: r.description,
      kept: r.source ? `${r.source.items} items, ${r.source.status}` : "not synced yet",
      use: r.source ? `search_knowledge with source "${r.source.id}"` : `add_source with template "${r.id}" (syncs it, then search_knowledge)`,
      score: r.score,
    };
  }
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

// An answer that hands the work back to the user instead of doing it.
const ASKS = /\?\s*$|let me know|which (one|tool|account)|would you like|do you want|please (specify|clarify|confirm|provide)|уточни|какой из|какую из|хотите ли|подскажите|выберите/i;
const NO_QUESTIONS =
  "Do not ask the user. Do the task now with the most likely reading: find the tool (search_tools with the app name and the action), " +
  "run it, and answer from the result; say in one line what you assumed.";

// A tool that keeps failing is stopped after this many failures in one round, so a run never spins on it.
const MAX_TOOL_FAILURES = 3;
const MAX_SEARCHES = 3;
const STRONG_RECIPE = 0.45; // a recipe this close to the task is known ground: the fast model is enough

const SYNC_INTENT = /запомн|помни|держи .*актуал|актуальн|синхрон|проиндекс|индексир|remember|keep .*(up to date|in sync|current)|\bsync\b|index /i;

const TEMPLATE_HELP =
  'template: a live sync recipe — built in: github (files of a repository), notion (a page and every page under it, or all pages ' +
  "shared with Genter) — or the id of a saved one (search shows them as live_sync). " +
  "Pass pick (the repo or page name as the user said it) or scope. It is kept up to date on every change unless watch is false. " +
  'depth: "titles" (names and links only, fast), "summary" (a short summary per item), "full" (whole text, default).';

function briefing({ task, mode, account, found, connected, canExecute, english, sources = [], knowledge = [], named = [] }) {
  const recipes = found.filter((r) => r.id).map(compactFound);
  const tools = found.filter((r) => !r.id).map(compactFound);
  const apps = connected.map((c) => `${c.toolkit}${c.alias ? ` (${c.alias}${c.default ? ", default" : ""})` : ""}${c.status && c.status !== "ACTIVE" ? ` [${c.status}]` : ""}`);
  return [
    `Task: ${task}`,
    english?.en && `In English: ${english.en}`,
    english?.terms?.length && `Search terms for keyword filters (use both languages, joined with OR): ${english.terms.join(" | ")}`,
    mode === "find" ? "Mode: find (read-only: answer the question; only execute tools that read data)." : "Mode: run (do the task).",
    SYNC_INTENT.test(task) &&
      "This asks to remember or keep content up to date: add_source (built-in github files / notion pages, or a saved live_sync recipe), otherwise build_live_sync. Not a one-off execute.",
    !canExecute && "This user cannot run tools: answer from recipe summaries, or say which tool and args would do it.",
    account && `Use connection: ${account}`,
    `Connected apps: ${apps.join(", ") || "none"}`,
    named.length && `The task is about ${named.join(", ")}: read the user's data there with its tools (search_tools "${named[0]} ..." if none below fits), not other apps.`,
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
- Synced sources are an app's content kept searchable (a GitHub repo, Notion pages). Use search_knowledge for more of it. When the user asks to remember, index or keep an app's content up to date, call add_source; to refresh one, sync_source. Filters in the user's words ("only docs/", "no tests", "only the last 200") go to add_source filter.
- Built-in live sync recipes cover only: github = the FILES of a repository; notion = pages. A saved one (live_sync in the first message) fits too: add_source with its id. Anything else (issues, pull requests, commits, emails, tickets, messages, rows, any other app) needs a new live sync recipe: call build_live_sync with the whole goal in the user's words; it builds, tests, saves and adds the source. Never use a built-in one for something it does not cover, and never answer a remember/sync request with a one-off execute.
- If a recipe fits, execute it by id and override only the args that differ. This is the fastest path.
- Otherwise pick a candidate tool and execute it. Call get_tool_schema only when the args are unclear; call search_tools only when nothing fits.
- Make independent calls in the same step (parallel). Chain only when a call needs another's output.
- Never invent tool slugs or argument names: use only slugs from the first message, search results or error hints.
- Keyword search in apps (Gmail q, Slack, Drive, Notion, GitHub search) matches literal words, and the data is often in another language than the request (English emails, Russian request). Put the key terms in both languages in one query, joined with OR, e.g. Gmail: ("объединенные знания" OR "unified knowledge" OR "merged knowledge"). The first message lists the terms.
- A failed call is not retried with the same args. "Not Found" from an app means the repo, file or id is wrong, not the tool: find the real one (list the user's repos, search) instead of guessing. After two failures of a tool, answer with what you have.
- A connected app always has tools: never answer that there is no tool for it. If no candidate fits, search_tools with the app name and what to do (e.g. "Google Tasks list tasks"), then execute.
- A name you do not know (an org, a project, a repo, a person): look it up in the connected apps first (e.g. the user's GitHub repositories and orgs) and answer about what you found. "Projects" in GitHub usually means repositories: list them (and Projects only if asked).
- "What's new in <app>" / "что нового в <app>" for a connected app means the user's own latest items there (recently created or updated tasks, issues, emails, files), read with that app's tools, not news about the product.
- Every fact in the answer comes from a tool result, a recipe summary or synced knowledge of this run. Never answer from general knowledge about a product or company; if nothing was found, say what was checked.
- An empty result is not an answer: retry once with translated or broader terms before saying nothing was found.
- Every successful call is saved as a recipe: the exact call, named by its result, with no parameters. When you execute a tool that did not come from a recipe, pass description, short and tags so the next run finds its result:
  description is Markdown named by what this exact call returns: "### <the result>" (e.g. "### Open pull requests of Genterai/genter-cli"), then what the result holds and how it is filtered, "- pitfall: ..." bullets if any; short is that name in one line under 100 characters; tags in English and Russian. Leave them out for a step whose result is only a means (an id lookup): it is named automatically.
- A sync recipe (kind sync) keeps an app's content as embeddings: a whole GitHub project (files, issues, pull requests), mail, events. Its knowledge is in the first message when it matches; search_knowledge with its source reads more of it.
- If a recipe returned something different from its description, save it again with status "outdated" (save_recipes) and say why.
- An app the task needs is not connected: call connect_app and stop.
- Never ask the user anything and never end with a question or a choice for them. Ambiguous: take the most likely reading (the default account, the latest, all of them, the closest name), do it, and say in one line what you assumed. Only an irreversible action (delete, send, pay) on a target you cannot pin down is not done: say what was not done and why.
- An app is connected several times: pass account (alias or id) when the user names one; otherwise the default is used.
Always end with an answer built from what you found, even partial; never "I can't" while a tool could still be tried.
Final answer: short and concrete, in the user's language. Include the names, ids and links needed to open or continue the result. Say what was done, not how.`;

const recipeFields = {
  description: { type: "string", description: "Markdown named by this call's result, no parameters (see instructions)" },
  short: { type: "string", description: "The result's name in one line under 100 characters, e.g. 'Open pull requests of Genterai/genter-cli'" },
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
        template: { type: "string", description: "github, notion or a saved live sync recipe id" },
        filter: {
          type: "object",
          properties: {
            include: { type: "string", description: "Regex over '<id> <title>', case-insensitive, e.g. ^docs/ or roadmap" },
            exclude: { type: "string", description: "Regex over '<id> <title>', e.g. (^|/)tests?/" },
            maxItems: { type: "integer" },
          },
        },
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
    name: "build_live_sync",
    description:
      "Remember content that no live sync recipe covers yet (issues, pull requests, emails, tickets, rows... of any app): " +
      "a builder writes a live sync recipe from the app's tools, tests it on real data, saves it, then adds, syncs and watches the source.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What to remember, with every known detail, e.g. 'all pull requests of Genterai/genter-backend: title and description'" },
        toolkit: { type: "string", description: "App slug, e.g. github, linear, gmail" },
        depth: { type: "string", enum: ["titles", "summary", "full"] },
        watch: { type: "boolean" },
        account: { type: "string" },
      },
      required: ["goal"],
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
].map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));

const TASK_TOOLS = TOOLS.filter((t) => !["add_source", "build_live_sync"].includes(t.function.name));
const SYNC_TOOLS = TOOLS.filter((t) => ["add_source", "build_live_sync", "sync_source", "search_knowledge", "connect_app"].includes(t.function.name));
