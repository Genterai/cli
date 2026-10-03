import { randomUUID } from "node:crypto";
import { cipher, namedApps } from "./genter.js";
import { createBuilder } from "./builder.js";
import { appOf, applyEdits, citedRefs, fileEditor, needsCatalogue, refFromUrl, refLabel, refsOfResult, shapeRef, writeHints } from "./refs.js";
import { locatorArgs } from "./sync.js";

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
// References: every knowledge chunk, recipe, call result and item of a list the model sees gets a number, the answer
// cites them as [n], and a result lists the cited ones (refs.js): what each is, where it is (path, link, ids) and which
// write tools work there. write() writes at one of them (or at a link). A file is changed by edits (exact pieces of its
// text and what goes instead): it is read and committed here, so nobody writes the whole file out.
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
        for (const f of found) if (f.id && f.args) run.recipeArgs[f.id] = f.args;
        const shown = found.map((f) => compactFound(f, recipeRef(run, f)));
        const hint = run.searches >= 2 ? "Pick the closest tool above and execute it now; do not search again." : undefined;
        return { content: JSON.stringify(hint ? { tools: shown, hint } : shown) };
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
        const out = await executeOn(run, input, input.account).catch((e) => ({ thrown: e.message }));
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
        run.steps.push({ tool: tool ?? input.id, recipe: input.id ?? null, ok, summary: out.summary ?? null, saved: out.id ?? null, ...(out.account && { account: out.account }) });
        onEvent({ type: "tool", tool: tool ?? input.id, recipe: input.id ?? null, ok, empty, summary: out.summary ?? (empty ? "nothing found" : null) });
        const args = { ...(input.id ? run.recipeArgs[input.id] : {}), ...(input.args ?? {}) };
        if (out.id) {
          run.recipes[out.id] = tool;
          run.recipeArgs[out.id] = args;
        }
        // What the model can cite: the call's one result, or each item of a list (`_ref` on the item).
        const cited = ok && !empty && data != null && tool ? refsOfResult({ app: appOf(tool, run.apps), tool, args, data }, (r) => register(run, r)) : { data, ref: null, items: [] };
        // An empty search is not an answer yet: the words may be in another language than the data, or too narrow.
        const retry =
          empty && !run.retried
            ? ((run.retried = true),
              "Empty result. Do not answer 'not found' yet: retry once with the key terms in both languages joined with OR " +
                "(the data is often in English when the user writes in another language, and the other way round), " +
                "plus close synonyms, fewer words and no date filter.")
            : undefined;
        const missing = !ok && /not found|404|does not exist/i.test(String(JSON.stringify(out.result?.error ?? "")))
          ? `What these args point to does not exist (wrong owner, repo, path or id?)${out.tried > 1 ? `, on any of the ${out.tried} connected accounts` : ""}. Do not guess again: find the real name with a list or search tool first, or answer without it.`
          : undefined;
        // Found on another connection of the app than the default: the answer says on which.
        const short = { ref: cited.ref ?? undefined, id: out.id, successful: ok, account: out.account, summary: out.summary ?? undefined, error: ok ? undefined : out.result?.error, hint: retry ?? missing ?? out.hint };
        const text = ok ? JSON.stringify(cited.data) : "";
        // Stored without the data: the items it listed stay citable by their numbers.
        const items = run.refs.filter((r) => cited.items.includes(r.n)).map((r) => [r.n, String(r.title).slice(0, 80)]);
        return {
          content: JSON.stringify({ ...short, data: text.length > 10000 ? `${text.slice(0, 10000)}… (truncated)` : text || undefined }),
          keep: JSON.stringify({ ...short, ...(items.length && { items }), note: "raw data not stored; execute this id again for details" }),
        };
      }
      case "edit_file": {
        if (!canExecute) return { content: "Not allowed: this user can search but not change files." };
        if (run.mode === "find") return { content: "Not allowed: editing a file changes it and this is a read-only find. Tell the user to use run_task." };
        if ((run.failures.edit_file ?? 0) >= MAX_TOOL_FAILURES) return { content: JSON.stringify({ error: `edit_file failed ${MAX_TOOL_FAILURES} times in this run.`, hint: "Answer with what you have and say what did not work." }) };
        const place =
          input.ref != null
            ? run.refs.find((r) => r.n === Number(String(input.ref).replace(/\D/g, "")))
            : input.path && shapeRef({ app: "github", via: "call", tool: "GITHUB_GET_REPOSITORY_CONTENT", where: { owner: input.owner, repo: input.repo, path: input.path, branch: input.branch } });
        if (!place) return { content: JSON.stringify({ error: input.ref != null ? `No reference [${input.ref}] in this run` : "Pass ref (the file's reference number) or owner, repo and path" }) };
        const n = register(run, place);
        const out = await editFile({ run, place, edits: input.edits, message: input.message, account: input.account }).catch((e) => ({ error: e.message }));
        run.steps.push({ tool: "edit_file", recipe: null, ok: !out.error, summary: out.error ?? out.summary, saved: null });
        onEvent({ type: "tool", tool: "edit_file", ok: !out.error, summary: out.error ?? out.summary });
        if (out.error) {
          run.failures.edit_file = (run.failures.edit_file ?? 0) + 1;
          return { content: JSON.stringify({ ref: n, error: out.error, hint: "Make find the file's exact current text (the lines given above), or read the file first; then call edit_file again." }) };
        }
        return { content: JSON.stringify({ ref: n, committed: !out.unchanged, ...out }) };
      }
      case "search_knowledge": {
        const hits = await genter.knowledge({ query: input.query, limit: 8, source: input.source });
        return { content: JSON.stringify(hits.map((h) => compactHit(h, register(run, hitRef(h))))) };
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
    run.refs ??= [];
    run.recipeArgs ??= {};
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
    // The references the answer used, with how to write at each.
    if (result.status === "done") result.references = await withWrites(citedRefs(result.answer, run.refs, { round: run.round }));
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

  const api = {
    // Start a task. Recipes, candidate tools and connections are fetched in parallel before the first LLM call.
    // target (write): a reference to write at, with its write tools; the briefing ends with it.
    async start({ task, mode = "run", account, target }) {
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
        sync: mode === "run" && canExecute && !target && SYNC_INTENT.test(task),
        account,
        // Active connections, so a call one account cannot see is tried on the app's others (executeOn).
        connections: connected.filter((c) => !c.status || c.status === "ACTIVE").map((c) => ({ toolkit: c.toolkit, account: c.account, alias: c.alias, default: c.default })),
        status: "running",
        created_at: new Date().toISOString(),
        apps: [...new Set(connected.map((c) => c.toolkit))],
        // No valid recipe that clearly fits: this task is new, the strong model works it out (and leaves recipes).
        strong: !recipes.some((r) => r.status !== "outdated" && r.score >= STRONG_RECIPE),
        named, // apps the task is about
        recipes: Object.fromEntries(recipes.map((r) => [r.id, r.tool])),
        recipeArgs: Object.fromEntries(recipes.filter((r) => r.args).map((r) => [r.id, r.args])),
        steps: [],
        refs: [],
        round: 1, // each send or write is the next round; an answer with no marks falls back to its round's references
        timing: { search_ms },
      };
      const refer = (r) => register(run, r);
      const brief = briefing({ task, mode, account, found, connected, canExecute, english, sources, knowledge, named, recipeRef: (r) => recipeRef(run, r), hitRef: (h) => refer(hitRef(h)) });
      const write = target && writeNote({ ...target, n: refer(target) }, task);
      run.messages = [{ role: "user", content: write ? `${brief}\n\n${write}` : brief }];
      return loop(run);
    },

    // Continue a run: answer its question, say an app is connected, correct it, or give the next instruction.
    async send({ run_id, message }) {
      const run = await load(run_id);
      run.steps = [];
      run.messages.push({ role: "user", content: message });
      return loop(run);
    },

    // Write at a place a result referenced: ref is a reference number of run_id's result ([n]) or a link to the place.
    // With change: the agent writes it (continuing the run, so it knows what was found), with the place and its write
    // tools in front of it. With tool + args: that exact call, the reference's args under the given ones, no model step.
    // With edits (a file): the file is read, the edits applied and the result committed once, no model step.
    async write({ run_id, ref, change, tool, args, edits, message, account }) {
      const run = run_id ? await load(run_id) : null;
      const target = targetOf(run, ref);
      if (!target && !tool) throw new Error("Pass ref: a reference number [n] from run_id's result, or a link to the place");
      if (edits?.length) return editNow({ run, place: target, edits, message: message ?? change, account });
      if (!tool && !String(change ?? "").trim()) throw new Error("Pass change (what to write there), edits for a file, or tool + args for an exact call");
      const [place] = target ? await withWrites([target], 8000) : [null];
      if (tool) return writeNow({ run, place, tool, args, account });
      if (!run) return api.start({ task: change, account, target: place });
      run.steps = [];
      run.mode = "run"; // a find goes on as a run: writing is what was asked
      run.sync = false;
      if (account) run.account = account;
      run.messages.push({ role: "user", content: writeNote({ ...place, n: register(run, place) }, change) });
      return loop(run);
    },
  };
  return api;

  // A stored run, for its next round.
  async function load(run_id) {
    const row = await runs.get(run_id);
    if (!row) throw new Error(`Unknown run_id: ${run_id}`);
    const run = open(row.blob);
    run.refs ??= [];
    run.recipeArgs ??= {};
    run.round = (run.round ?? 1) + 1;
    return run;
  }

  // The references with write hints: known ones right away, other apps from their tool catalogue (cached for an hour;
  // a catalogue not loaded within `wait` ms leaves that reference without hints, write() finds them later).
  async function withWrites(refs, wait = 1500) {
    const apps = [...new Set(refs.filter(needsCatalogue).map((r) => r.app))];
    const catalogues = new Map(
      await Promise.all(
        apps.map(async (app) => {
          if (!genter.catalog) return [app, null];
          let timer;
          const late = new Promise((resolve) => {
            timer = setTimeout(resolve, wait, null);
            timer.unref?.();
          });
          const list = await Promise.race([genter.catalog({ toolkit: app }).catch(() => null), late]);
          clearTimeout(timer);
          return [app, list];
        }),
      ),
    );
    return refs.map(({ round, score, ...r }) => ({ ...r, write: writeHints(r, catalogues.get(r.app)) }));
  }

  // One exact write: the tool the caller picked, with the reference's args under theirs.
  async function writeNow({ run, place, tool, args = {}, account }) {
    if (!canExecute) throw new Error("This user can search but not run tools");
    if (place && appOf(tool, [place.app]) !== place.app) throw new Error(`${tool} is not a ${place.app} tool; the reference is in ${place.app}`);
    const hint = place?.write?.find((h) => h.tool === tool);
    const started = Date.now();
    onEvent({ type: "step", tool: "execute", input: { tool } });
    const out = await executeOn(run ?? {}, { tool, args: { ...hint?.args, ...args } }, account);
    const ok = out.result?.successful !== false;
    const data = ok ? out.result?.data : null;
    onEvent({ type: "tool", tool, ok, summary: ok ? null : String(JSON.stringify(out.result?.error ?? "failed")).slice(0, 200) });
    const text = JSON.stringify(data ?? null);
    const at = place ? ` at ${refLabel(place)}${place.url ? ` (${place.url})` : ""}` : "";
    const ms = Date.now() - started;
    return {
      run_id: run?.id ?? null,
      status: ok ? "done" : "failed",
      answer: ok
        ? `Done: ${tool}${at}.${data != null ? `\n\n${text.length > 2000 ? `${text.slice(0, 2000)}… (truncated)` : text}` : ""}`
        : `${tool} failed${at}: ${typeof out.result?.error === "string" ? out.result.error : JSON.stringify(out.result?.error ?? "unknown error")}`,
      steps: [{ tool, recipe: null, ok, summary: null, saved: out.id ?? null }],
      references: place ? [place] : [],
      usage: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, llm_ms: 0, search_ms: 0, tool_ms: ms, model: null, ms },
    };
  }

  // A call on the account asked for, else the one this run already found the app's data on, else the default.
  // An app connected several times (two GitHub accounts): what the default cannot see (another owner's repository:
  // 404, no access) is tried on the app's other connections. The one that works is kept for the app for the rest of
  // the run, so later reads and writes there (edit_file, GENTER_WRITE) go to it too. Returns the call's result with
  // account (its alias) and accountId when another connection answered, and tried: how many connections were tried.
  async function executeOn(run, input, account) {
    const app = appOf(input.tool ?? run.recipes?.[input.id], run.apps);
    const chosen = account ?? run.account ?? run.accounts?.[app];
    const first = await genter.execute({ ...input, account: chosen });
    if (chosen || !notHere(first)) return chosen ? { ...first, accountId: chosen } : first;
    run.connections ??= await genter
      .login()
      .then((l) => (l.connected ?? []).filter((c) => !c.status || c.status === "ACTIVE"))
      .catch(() => []);
    const own = run.connections.filter((c) => c.toolkit === app);
    if (own.length < 2) return first;
    const others = own.some((c) => c.default) ? own.filter((c) => !c.default) : own;
    for (const c of others) {
      const out = await genter.execute({ ...input, account: c.account }).catch(() => null);
      if (out && out.result?.successful !== false) {
        (run.accounts ??= {})[app] = c.account;
        onEvent({ type: "account", app, account: c.alias ?? c.account });
        return { ...out, account: c.alias ?? c.account, accountId: c.account };
      }
    }
    return { ...first, tried: own.length };
  }

  // A file changed in one commit: read (its text and sha), the edits applied here, committed with that sha.
  // Neither call is saved as a recipe: they are steps of the edit, and the commit carries the whole file.
  async function editFile({ run, place, edits, message, account }) {
    if (!canExecute) throw new Error("This user can search but not change files");
    const editor = fileEditor(place);
    if (!editor) throw new Error(`[${place.n ?? "?"}] is a ${place.app} ${place.kind}, not a file that edits work on; write there with change or tool + args`);
    if (!String(message ?? "").trim()) throw new Error("Pass message: the commit message");
    const read = await executeOn(run ?? {}, { ...editor.read, remember: false }, account);
    if (read.result?.successful === false) throw new Error(`Could not read ${refLabel(place)}: ${errorText(read.result.error)}`);
    const file = editor.file(read.result?.data);
    const text = applyEdits(file.text, edits);
    if (text === file.text) return { unchanged: true, summary: "nothing changed: the edits give the same text" };
    // Committed on the account the file was read on.
    const out = await genter.execute({ ...editor.write({ text, sha: file.sha, message: String(message).trim() }), account: read.accountId ?? account, remember: false });
    if (out.result?.successful === false) throw new Error(`Could not commit ${refLabel(place)}: ${errorText(out.result.error)}`);
    const before = file.text.split("\n").length;
    const after = text.split("\n").length;
    return { summary: `${edits.length} edit${edits.length === 1 ? "" : "s"} committed to ${refLabel(place)} (${before} → ${after} lines)`, commit: editor.link(out.result?.data) ?? null };
  }

  // GENTER_WRITE with edits: one commit, no model step.
  async function editNow({ run, place, edits, message, account }) {
    if (!place) throw new Error("Pass ref: the file's reference number [n] from run_id's result, or a link to it");
    const started = Date.now();
    onEvent({ type: "step", tool: "edit_file", input: { file: refLabel(place) } });
    const out = await editFile({ run, place, edits, message, account }).catch((e) => ({ error: e.message }));
    onEvent({ type: "tool", tool: "edit_file", ok: !out.error, summary: out.error ?? out.summary });
    const ms = Date.now() - started;
    return {
      run_id: run?.id ?? null,
      status: out.error ? "failed" : "done",
      answer: out.error ? `Not committed: ${out.error}` : `${out.summary}.${out.commit ? ` Commit: ${out.commit}` : ""}`,
      steps: [{ tool: "edit_file", recipe: null, ok: !out.error, summary: out.error ?? out.summary, saved: null }],
      references: [place],
      usage: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, llm_ms: 0, search_ms: 0, tool_ms: ms, model: null, ms },
    };
  }
}

// A failure that may be this account's view, not the call: what it points to is missing or not visible to it.
const notHere = (out) =>
  out?.result?.successful === false && /not found|\b40[134]\b|forbidden|not accessible|permission|unauthori[sz]ed|bad credentials/i.test(errorText(out.result.error));

const errorText = (e) => (typeof e === "string" ? e : JSON.stringify(e ?? "failed")).slice(0, 300);

// A reference the model sees: numbered once per run (the same place keeps its number, and what is learned about it
// later is added). null once a run has MAX_REFS.
function register(run, { write, ...ref }) {
  run.refs ??= [];
  const key = refKey(ref);
  const known = run.refs.find((r) => refKey(r) === key);
  if (known) {
    Object.assign(known, { ...ref, n: known.n, where: { ...known.where, ...ref.where }, round: run.round });
    return known.n;
  }
  if (run.refs.length >= MAX_REFS) return null;
  const n = (run.refs.at(-1)?.n ?? 0) + 1;
  run.refs.push({ ...ref, n, round: run.round });
  return n;
}
const refKey = (r) => `${r.app}:${r.kind}:${r.url ?? JSON.stringify(Object.entries(r.where ?? {}).sort())}`;
const MAX_REFS = 300;

// A saved recipe as a reference: the call it makes points somewhere (its args). Not sync recipes: their chunks are.
const recipeRef = (run, r) =>
  r.id && r.kind !== "sync" && r.tool
    ? register(run, shapeRef({ app: appOf(r.tool, run.apps), via: "recipe", tool: r.tool, title: r.short ?? r.description?.split("\n")[0]?.replace(/^#+\s*/, ""), where: locatorArgs(r.args ?? {}) }))
    : undefined;

// A synced knowledge chunk as a reference: its item, where it is, and the source it was synced from.
const hitRef = (h) =>
  shapeRef({ app: h.toolkit, via: "knowledge", source: h.source, title: h.title, url: h.url, item: h.item, part: h.part, tool: h.tool, where: h.where, text: h.text, score: h.score });

// The place a write is for: a reference number of the run ("3", "[3]"), or a link (one of the run's, or any link
// refs.js knows). null without ref.
function targetOf(run, ref) {
  if (ref == null || ref === "") return null;
  const text = String(ref).trim();
  const number = text.match(/^\[?#?(\d+)\]?$/)?.[1];
  if (number) {
    if (!run) throw new Error(`ref ${number} is a reference number: pass the run_id of the result it is from`);
    const found = run.refs.find((r) => r.n === Number(number));
    if (!found) throw new Error(`run ${run.id} has no reference [${number}]; it has ${run.refs.length ? `[1]..[${run.refs.at(-1).n}]` : "none"}`);
    return found;
  }
  const known = run?.refs.find((r) => r.url === text) ?? refFromUrl(text);
  if (!known) throw new Error(`Unknown place: ${text}. Pass a reference number of run_id's result, or a link to a GitHub file, issue or pull request, a Notion page, a Gmail thread or a Calendar event`);
  return known;
}

// The write the agent is asked for: the place, its write tools with their args, how to read what is there, the change.
function writeNote(place, change) {
  const hints = place.write ?? [];
  const editor = fileEditor(place);
  return [
    `Write at [${place.n}]: ${place.app} ${place.kind} ${refLabel(place)}${place.url ? ` (${place.url})` : ""}`,
    `It is at: ${JSON.stringify(place.where ?? {})}`,
    editor &&
      `Change this file with edit_file {ref: ${place.n}, edits: [{find: "<its exact current text>", replace: "<the new text>"}], message: "<commit message>"} ` +
        "({append} adds at the end). It is read and committed for you in one commit and only those pieces change: never write the whole file out. " +
        `find must be the exact text, a few whole lines; when you do not have it, read the file first: ${editor.read.tool} ${JSON.stringify(editor.read.args)}.`,
    hints.length
      ? `${editor ? "To create a new file instead" : "Write tools for it"}, args already filled (pass them as they are, add only the rest):\n${hints.map((h) => `- ${h.tool} ${JSON.stringify(h.args)}${h.needs.length ? ` + ${h.needs.join(", ")}` : ""} — ${h.does}`).join("\n")}`
      : `No write tool is known for it yet: search_tools "${place.app} ${place.kind} update" (or "comment", "add"), then execute with the args above.`,
    `Change: ${change}`,
    "Write only there, in as few steps as possible. Then answer with what was written and its link.",
  ]
    .filter(Boolean)
    .join("\n");
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

// Search results as the model sees them: recipes in full (with their reference number), Composio tools with a compact
// arg schema.
function compactFound(r, ref) {
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
    return { ref, id: r.id, tool: r.tool, args: r.args, description: r.description, result_summary: r.summary, when: r.when, status: r.status, score: r.score };
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

// A knowledge chunk as the model sees it, with its reference number.
const compactHit = (h, ref) => ({ ref: ref ?? undefined, source: h.source_title, title: h.title, url: h.url, score: h.score, text: h.text.slice(0, 1200) });

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

function briefing({ task, mode, account, found, connected, canExecute, english, sources = [], knowledge = [], named = [], recipeRef = () => undefined, hitRef = () => undefined }) {
  const recipes = found.filter((r) => r.id).map((r) => compactFound(r, recipeRef(r)));
  const tools = found.filter((r) => !r.id).map((r) => compactFound(r));
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
    knowledge.length && `Knowledge from synced sources matching the task (best first):\n${JSON.stringify(knowledge.map((h) => compactHit(h, hitRef(h))))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SYSTEM = `You are Genter's task agent. You act in the user's connected apps through Composio tools, and you are judged on speed: the fewest steps that give a correct, complete result.

The first message already holds everything for a fast start: saved recipes that match the task (proven past calls with their args and a summary of what they returned), candidate Composio tools with their args, and the connected apps.
- If a recipe's result_summary or the knowledge from synced sources already answers the question, answer right away without calling anything.
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
- Cite where each fact comes from: right after it, the ref number of the knowledge chunk, recipe, tool result or list item (its _ref) in square brackets, e.g. "Paging stops at a short page [3]." or "[2, 5]". Cite only what you used; never invent numbers. The user gets the cited places (paths, links, ids) with the answer.
- To change an existing file of a repository, call edit_file with exact pieces of its current text and what goes instead: it reads and commits the file for you. Never write a whole existing file out; GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS is for new files.
- An empty result is not an answer: retry once with translated or broader terms before saying nothing was found.
- Every successful call is saved as a recipe: the exact call, named by its result, with no parameters. When you execute a tool that did not come from a recipe, pass description, short and tags so the next run finds its result:
  description is Markdown named by what this exact call returns: "### <the result>" (e.g. "### Open pull requests of Genterai/genter-cli"), then what the result holds and how it is filtered, "- pitfall: ..." bullets if any; short is that name in one line under 100 characters; tags in English and Russian. Leave them out for a step whose result is only a means (an id lookup): it is named automatically.
- A sync recipe (kind sync) keeps an app's content as embeddings: a whole GitHub project (files, issues, pull requests), mail, events. Its knowledge is in the first message when it matches; search_knowledge with its source reads more of it.
- If a recipe returned something different from its description, save it again with status "outdated" (save_recipes) and say why.
- An app the task needs is not connected: call connect_app and stop.
- Never ask the user anything and never end with a question or a choice for them. Ambiguous: take the most likely reading (the default account, the latest, all of them, the closest name), do it, and say in one line what you assumed. Only an irreversible action (delete, send, pay) on a target you cannot pin down is not done: say what was not done and why.
- An app is connected several times: pass account (alias or id) when the user names one; otherwise the default is used, and a call the default cannot see (another owner's repo: not found, no access) is retried on the app's other connections by itself. A result with account says which connection had it: say so in the answer. Not found on every account means the name is wrong, not the account.
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
    name: "edit_file",
    description:
      "Change an existing file of a repository in one commit: exact pieces of its current text and what goes instead. " +
      "The file is read and committed for you; only those pieces change. Use it for every change to an existing file instead of writing the whole file.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The file's reference number" },
        owner: { type: "string", description: "Without ref: the repository owner" },
        repo: { type: "string" },
        path: { type: "string" },
        branch: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Exact current text, a few whole lines, found once in the file" },
              replace: { type: "string", description: "What goes instead (empty to delete it)" },
              append: { type: "string", description: "Instead of find/replace: text to add at the end of the file" },
            },
          },
        },
        message: { type: "string", description: "Commit message" },
        account: { type: "string" },
      },
      required: ["edits", "message"],
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
