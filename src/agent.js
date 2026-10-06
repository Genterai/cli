import { randomUUID } from "node:crypto";
import { cipher, namedApps } from "./genter.js";
import { appOf, applyEdits, citedRefs, fileEditor, needsCatalogue, refFromUrl, refLabel, refsOfResult, shapeRef, writeHints } from "./refs.js";
import { inferList, locatorArgs, pick } from "./shape.js";
import { logCost, usageFields } from "./cost.js";

// The task agent: an LLM loop over genter (search -> execute -> save), tuned for speed.
// Before the first LLM call it already has, in parallel: the saved recipes matching the task (found by
// what they do and by what they returned), candidate Composio tools with compact arg schemas, and the
// connected apps. So a known task is usually one tool call and an answer, and a recipe's result summary
// can answer a question with no tool call at all.
// A run can pause (a question for the user, an app to connect) and be continued with `send`.
// Runs are stored encrypted: { id, blob }. Tool results are kept only as their summaries, never raw.
//
// mode "run": do the task. mode "find": read-only, only tools that read data run.
// mode "recipes" (MCP GENTER_FIND): read-only, and the model writes no answer: it finds and runs the calls whose results
// hold what was asked (saved recipes that fit, or new calls, which become recipes) and names their ids; the run ends with
// those recipes' current raw results (`results`), for the caller's own model to answer from.
// canExecute false: no tool runs at all (dashboard viewers); the agent answers from recipes and plans.
// References: every knowledge chunk, recipe, call result and item of a list the model sees gets a number, the answer
// cites them as [n], and a result lists the cited ones (refs.js): what each is, where it is (path, link, ids) and which
// write tools work there. write() writes at one of them (or at a link). A file is changed by edits (exact pieces of its
// text and what goes instead): it is read and committed here, so nobody writes the whole file out.
// instructions: what a workspace admin wrote for this person (tone, language, defaults, what to stay away from).
// They go to the model in every run, after the fixed system prompt; they shape the work, not what may run.
export function createAgent({
  genter,
  openrouterApiKey,
  secret,
  userId,
  runs, // get(id) -> { blob } | undefined, put({ id, blob })
  model = process.env.AGENT_MODEL || "openai/gpt-oss-120b",
  // A task no saved recipe covers yet, or a run the fast model gets stuck on, goes to a stronger model
  // (AGENT_STRONG_MODEL; the same one by default: none of the models tried did these tasks better, README → Models).
  // What it finds becomes recipes, so the next time the same task runs on the fast one.
  strongModel = process.env.AGENT_STRONG_MODEL || "openai/gpt-oss-120b",
  maxSteps = 12,
  canExecute = true,
  canConnect = true,
  instructions,
  onEvent = () => {},
}) {
  if (!openrouterApiKey) throw new Error("The agent needs an OpenRouter key (OPENROUTER_API_KEY)");
  const { seal, open } = cipher(`${secret}:${userId}:runs`);
  let lastNote = null;
  let currentRun = {};
  const personal = String(instructions ?? "").trim();
  const preamble = [{ role: "system", content: SYSTEM }, ...(personal ? [{ role: "system", content: personalNote(personal) }] : [])];

  async function llm(messages, usage, tools = TOOLS, toolChoice, useModel = model) {
    const started = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        provider: { sort: process.env.OPENROUTER_SORT || "latency" }, // the quickest provider to answer (see README → Models)
        // The system prompt and tool list never change, so providers can cache this prefix; a person's instructions follow it.
        messages: [...preamble, ...messages.map(({ keep, ...m }) => m)],
        tools,
        parallel_tool_calls: true,
        ...(toolChoice && { tool_choice: toolChoice }),
        temperature: 0,
        reasoning: { effort: "low" }, // the fast agent: short thinking, quick tool calls
        usage: { include: true },
      }),
    });
    if (!res.ok) {
      logCost({ type: "llm", model: useModel, source: "agent_step", ok: false, ms: Date.now() - started });
      throw new Error(`Agent model failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    logCost({ type: "llm", model: useModel, source: "agent_step", ms: Date.now() - started, ...usageFields(data) });
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
    // Args written as JSON text (the schema leaves their type open) are read as the object they say.
    if ("args" in (input ?? {})) input = { ...input, args: argsObject(input.args) };
    if (Array.isArray(input?.calls)) input = { ...input, calls: input.calls.map((c) => (c && "args" in c ? { ...c, args: argsObject(c.args) } : c)) };
    // One of these tools called through execute ({tool: "read_each", args: {...}}, as gpt-oss does after a run of executes)
    // is that tool with those args.
    if (name === "execute" && input.tool !== "execute" && TOOL_NAMES.has(String(input.tool ?? ""))) {
      const { tool, args, ...rest } = input;
      return call(run, tool, { ...rest, ...args });
    }
    switch (name) {
      case "search_tools": {
        // A model that keeps searching instead of running something: after a few searches it must execute.
        run.searches = (run.searches ?? 0) + 1;
        if (run.searches > MAX_SEARCHES) {
          return { content: JSON.stringify({ error: "No more searching.", hint: `Execute now the closest tool you already have: ${[...(run.seen ?? [])].slice(0, 8).join(", ")}. Then answer.` }) };
        }
        const found = await genter.search({ query: input.query, limit: 6, apps: run.apps, toolkits: run.named, tools: true, connected: true });
        run.seen = new Set([...(run.seen ?? []), ...found.filter((f) => f.tool).slice(0, 4).map((f) => f.tool)]);
        for (const f of found) if (f.id && f.args) run.recipeArgs[f.id] = f.args;
        for (const f of found) if (f.id && f.tool) (run.recipes ??= {})[f.id] ??= f.tool;
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
        // A call with neither a slug nor a known recipe id: it counts as a failure, so the run moves to the strong model.
        if (!tool && !input.id) {
          run.failures.execute = (run.failures.execute ?? 0) + 1;
          onEvent({ type: "tool", tool: "execute", ok: false, summary: "no tool or id" });
          // A prepare task with a list in hand: the empty call was meant to read its items.
          const list = run.mode === "prepare" && Object.keys(run.lists ?? {}).at(-1);
          const each = list && `To read every listed item, call execute {tool: "read_each", args: {list_id: "${list}", read_tool: <the tool that reads ONE item>, shared_args: {...}, item_arg: <e.g. path>}}.`;
          return { content: JSON.stringify({ error: "Pass tool (a slug from the first message or search results) and args, or id of a saved recipe.", ...(each && { hint: each }) }) };
        }
        if (READ_ONLY_MODES.includes(run.mode) && tool && !isReadOnly(tool)) {
          return { content: `Not allowed: ${tool} changes data and this is a read-only ${run.mode}. Only read, or tell the user to use run_task.` };
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
          const similar = await genter.search({ query: tool.toLowerCase().replace(/_/g, " "), limit: 5, apps: run.apps, tools: true, connected: true }).catch(() => []);
          onEvent({ type: "tool", tool, ok: false, summary: "no such tool" });
          return { content: JSON.stringify({ error: `${tool} does not exist`, use_one_of: similar.map(compactFound) }) };
        }
        // A tool of an app that is not connected fails at once ("no connected account"): the model gets the connected
        // apps and their closest tools instead of trying it again or giving up.
        const app = tool && appOf(tool, run.apps);
        if (error && app && app !== "skill" && run.apps?.length && !run.apps.includes(app)) {
          const similar = await genter.search({ query: `${run.task ?? ""} ${tool.toLowerCase().replace(/_/g, " ")}`, limit: 5, apps: run.apps, tools: true, connected: true }).catch(() => []);
          onEvent({ type: "tool", tool, ok: false, summary: `${app} is not connected` });
          return { content: JSON.stringify({ error: `${tool} is a tool of ${app}, which is not connected. Connected apps: ${run.apps.join(", ")}.`, use_one_of: similar.map(compactFound), hint: "Use a tool of a connected app; only if none can do it, connect_app." }) };
        }
        if (out.thrown) throw new Error(out.thrown);
        const ok = out.result?.successful !== false;
        if (ok && tool && !isReadOnly(tool)) run.wrote = true;
        const data = ok ? (out.result?.data ?? null) : null;
        const empty = ok && isEmpty(data);
        // A prepare task keeps what a list call listed (in memory only, never stored), so read_each can read each item.
        const listed = ok && !empty && run.mode === "prepare" && out.id ? keepList(run, out.id, data) : 0;
        const recipe = ok && out.id ? { id: out.id, created: Boolean(out.created), changed: Boolean(out.changed) } : null;
        if (recipe) (run.touched ??= {})[recipe.id] = { ...(run.touched?.[recipe.id]), ...recipe, created: Boolean(run.touched?.[recipe.id]?.created || recipe.created), changed: Boolean(run.touched?.[recipe.id]?.changed || recipe.changed) };
        run.steps.push({ tool: tool ?? input.id, from_recipe: input.id ?? null, recipe, ok, summary: out.summary ?? null, saved: out.id ?? null, ...(out.recipe_status && out.recipe_status !== "fresh" && { recipe_status: out.recipe_status }), ...(out.account && { account: out.account }) });
        onEvent({ type: "tool", tool: tool ?? input.id, recipe, ok, empty, summary: out.summary ?? (empty ? "nothing found" : null) });
        const args = { ...(input.id ? run.recipeArgs[input.id] : {}), ...(input.args ?? {}) };
        if (out.id) {
          run.recipes[out.id] = tool;
          run.recipeArgs[out.id] = args;
        }
        // What the model can cite: the call's one result, or each item of a list (`_ref` on the item).
        // Each reference knows the recipe it came from, so the recipes an answer rests on are the ones it cites.
        const cited = ok && !empty && data != null && tool ? refsOfResult({ app: appOf(tool, run.apps), tool, args, data }, (r) => register(run, out.id ? { ...r, recipe: out.id } : r)) : { data, ref: null, items: [] };
        if (run.mode === "recipes" && ok && !empty && out.id) keepRaw(run, { id: out.id, from: input.id, tool, args, out, cited });
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
        const short = {
          ref: cited.ref ?? undefined, id: out.id, successful: ok, account: out.account, summary: out.summary ?? undefined, error: ok ? undefined : out.result?.error, hint: retry ?? missing ?? out.hint,
          ...(listed && { listed, next: `${listed} items listed: read every one in one call, execute {tool: "read_each", args: {list_id: "${out.id}", read_tool, shared_args, item_arg}}` }),
        };
        const text = ok ? JSON.stringify(cited.data) : "";
        // Stored without the data: the items it listed stay citable by their numbers.
        const items = run.refs.filter((r) => cited.items.includes(r.n)).map((r) => [r.n, String(r.title).slice(0, 80)]);
        return {
          content: JSON.stringify({ ...short, data: text.length > 10000 ? `${text.slice(0, 10000)}… (truncated)` : text || undefined }),
          keep: JSON.stringify({ ...short, ...(items.length && { items }), note: "raw data not stored; execute this id again for details" }),
        };
      }
      case "read_file": {
        // Reading a repository file is the base of most code tasks, and tool search does not surface it
        // ("read file" finds READMEs and gists, not GITHUB_GET_REPOSITORY_CONTENT): it is built in, like edit_file.
        if (!canExecute) return { content: "Not allowed: this user can search but not run tools. Answer from what recipes say, or say which tool would do it." };
        const place = fileRef(run, input);
        if (!place) return { content: JSON.stringify({ error: input.ref != null ? `No reference [${input.ref}] in this run` : "Pass ref (the file's reference number) or owner, repo and path" }) };
        const n = register(run, place);
        const out = await readFile({ run, place, account: input.account || undefined }).catch((e) => ({ error: e.message }));
        if (out.error) run.failures.read_file = (run.failures.read_file ?? 0) + 1;
        // mode "recipes": the read is a recipe like any call, and its result is kept to be handed over.
        const { summary, saved: read, ...shown } = out;
        const recipe = read ? { id: read.id, created: read.created, changed: read.changed } : null;
        if (read) {
          const ref = run.refs.find((r) => r.n === n);
          if (ref) ref.recipe = read.id;
          keepRaw(run, { id: read.id, tool: read.tool, args: read.args, out: read, cited: { data: read.data, ref: n, items: [] } });
          run.recipes[read.id] = read.tool;
          run.recipeArgs[read.id] = read.args;
          (run.touched ??= {})[read.id] = { ...recipe, created: Boolean(run.touched?.[read.id]?.created || recipe.created), changed: Boolean(run.touched?.[read.id]?.changed || recipe.changed) };
        }
        run.steps.push({ tool: "read_file", from_recipe: null, recipe, ok: !out.error, summary: out.error ?? summary, saved: read?.id ?? null });
        onEvent({ type: "tool", tool: "read_file", recipe, ok: !out.error, summary: out.error ?? summary });
        return {
          content: JSON.stringify({ ref: n, ...(read && { id: read.id }), ...shown, ...(out.error && { hint: "Check owner, repo and path (list the repository's files or the commit's files first)." }) }),
          keep: JSON.stringify({ ref: n, ...(read && { id: read.id }), ...(out.error ? { error: out.error } : { summary }), note: "the text is not stored; read_file again for it" }),
        };
      }
      case "edit_file": {
        if (!canExecute) return { content: "Not allowed: this user can search but not change files." };
        if (READ_ONLY_MODES.includes(run.mode)) return { content: `Not allowed: editing a file changes it and this is a read-only ${run.mode}. Tell the user to use run_task.` };
        if ((run.failures.edit_file ?? 0) >= MAX_TOOL_FAILURES) return { content: JSON.stringify({ error: `edit_file failed ${MAX_TOOL_FAILURES} times in this run.`, hint: "Answer with what you have and say what did not work." }) };
        const place = fileRef(run, input);
        if (!place) return { content: JSON.stringify({ error: input.ref != null ? `No reference [${input.ref}] in this run` : "Pass ref (the file's reference number) or owner, repo and path" }) };
        const n = register(run, place);
        const out = await editFile({ run, place, edits: input.edits, message: input.message, account: input.account || undefined }).catch((e) => ({ error: e.message }));
        run.steps.push({ tool: "edit_file", from_recipe: null, recipe: null, ok: !out.error, summary: out.error ?? out.summary, saved: null });
        onEvent({ type: "tool", tool: "edit_file", ok: !out.error, summary: out.error ?? out.summary });
        if (out.error) {
          run.failures.edit_file = (run.failures.edit_file ?? 0) + 1;
          return { content: JSON.stringify({ ref: n, error: out.error, hint: "Make find the file's exact current text (the lines given above), or read the file first; then call edit_file again." }) };
        }
        if (!out.unchanged) run.wrote = true;
        return { content: JSON.stringify({ ref: n, committed: !out.unchanged, ...out }) };
      }
      case "suggest_prepare": {
        // No side effects: the UI offers "prepare this area"; accepting starts a prepare run.
        const label = String(input.label ?? "").trim().slice(0, 120);
        if (label && !(run.suggestions ??= []).some((x) => x.label === label)) run.suggestions.push({ label, ...(input.why && { why: String(input.why).slice(0, 300) }) });
        return { content: JSON.stringify({ noted: Boolean(label) }) };
      }
      // Named so that no tool's name begins with another's: gpt-oss on Groq broke every call of "execute_many" into
      // "execute<|channel|>..." and the provider refused it. The old names are still understood.
      case "read_many":
      case "execute_many": {
        if (!canExecute) return { content: "Not allowed: this user can search but not run tools." };
        if (run.mode !== "prepare") return { content: "read_many is only for a prepare task. Use execute." };
        return executeMany(run, input);
      }
      case "read_each":
      case "execute_each": {
        if (!canExecute) return { content: "Not allowed: this user can search but not run tools." };
        if (run.mode !== "prepare") return { content: "read_each is only for a prepare task. Use execute." };
        return executeEach(run, input);
      }
      case "recheck_recipe": {
        if (!canExecute) return { content: "Not allowed: this user can search but not run tools." };
        if (!input.id) return { content: JSON.stringify({ error: "Pass id of the recipe" }) };
        const started = Date.now();
        const out = await genter.recipes.recheck(input.id).catch((e) => ({ error: e.message }));
        run.timing.tool_ms += Date.now() - started;
        const ok = !out.error && out.status !== "failed";
        run.steps.push({ tool: "recheck_recipe", from_recipe: input.id, recipe: out.recipe ? { id: input.id, created: false, changed: Boolean(out.changed) } : null, ok, summary: out.error ?? out.status, saved: out.recipe ? input.id : null });
        onEvent({ type: "tool", tool: "recheck_recipe", ok, summary: out.error ?? `${out.status}${out.changed ? ", changed" : ""}` });
        if (out.recipe) (run.touched ??= {})[input.id] = { id: input.id, created: false, changed: Boolean(out.changed) };
        return { content: JSON.stringify({ id: input.id, status: out.status, changed: out.changed, title: out.recipe?.title, error: out.error ?? (out.status === "failed" ? out.error : undefined) }) };
      }
      case "forget_recipe": {
        if (!canExecute) return { content: "Not allowed: this user can search but not run tools." };
        if (!input.id) return { content: JSON.stringify({ error: "Pass id of the recipe" }) };
        const out = await genter.recipes.markGone(input.id).then(() => ({ id: input.id, status: "gone" }), (e) => ({ error: e.message }));
        run.steps.push({ tool: "forget_recipe", from_recipe: input.id, recipe: null, ok: !out.error, summary: out.error ?? (input.reason ? String(input.reason).slice(0, 200) : "gone"), saved: null });
        onEvent({ type: "tool", tool: "forget_recipe", ok: !out.error, summary: out.error ?? "gone" });
        return { content: JSON.stringify(out) };
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
    run.nudged = false;
    run.unstuck = false;
    run.prompted = false;
    run.leaked = false;
    run.searches = 0;
    run.seen = new Set();
    run.touched = {}; // recipe id -> { id, created, changed } of this round
    run.raw = {}; // mode "recipes": recipe id -> its raw result of this round (memory only, never stored)
    run.suggestions = [];
    run.failed = {}; // "<tool> <args>" -> error of a call that failed in this round
    run.failures = {}; // tool -> failed calls in this round
    run.wrote = false; // something was written or committed in this round
    run.pressed = false;
    let result = null;
    try {
      for (let step = 0; step < maxSteps && !result; step++) {
        // Stuck on the fast model (failed calls, searching again and again): the rest of the run goes to the strong one.
        if (!run.strong && (Object.keys(run.failures).length || run.searches >= 2 || run.nudged || run.unstuck || run.prompted || run.retried)) run.strong = true;
        const message = asCalls(await llm(run.messages, usage, toolsFor(run.mode), undefined, run.strong ? strongModel : model), `call_${run.id.slice(0, 8)}_${step}`);
        run.messages.push({ role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length && { tool_calls: message.tool_calls }) });
        if (!message.tool_calls?.length) {
          // The model's reasoning or a broken call written as text is never the answer: sent back once, then it fails.
          if (LEAKED.test(message.content ?? "")) {
            if (!run.leaked && step < maxSteps - 1) {
              run.leaked = true;
              run.messages.pop(); // not kept: the model would go on from its own reasoning
              run.messages.push({ role: "user", content: NOT_AN_ANSWER });
              continue;
            }
            result = { status: "failed", answer: "The agent did not give an answer. Run it again." };
            break;
          }
          // An answer that is a question for the user: once, it is sent back to do the task instead.
          if (ASKS.test(message.content ?? "") && !run.nudged && step < maxSteps - 2) {
            run.nudged = true;
            run.messages.push({ role: "user", content: NO_QUESTIONS });
            continue;
          }
          // An answer that gives up on a part ("there is no tool to read files"): once, it is sent back to find the
          // tool and do it, on the strong model.
          if (GIVES_UP.test(message.content ?? "") && !run.unstuck && step < maxSteps - 2) {
            run.unstuck = true;
            run.messages.push({ role: "user", content: NO_GIVING_UP });
            continue;
          }
          // A write that ends without writing anything (no commit, no write call that worked): sent back once to write,
          // then it fails. Never "done" for a change that is not there.
          if (run.writing && !run.wrote) {
            if (!run.pressed && step < maxSteps - 2) {
              run.pressed = true;
              run.messages.push({ role: "user", content: NOTHING_WRITTEN });
              continue;
            }
            result = { status: "failed", answer: `Nothing was written.${message.content?.trim() ? ` ${message.content.trim()}` : ""}` };
            break;
          }
          // A model that ends without text after reading something: once, it is asked for the answer. In mode "recipes"
          // no text is needed once a result is kept: the run hands over what it read.
          const handsOver = run.mode === "recipes" && Object.keys(run.raw ?? {}).length > 0;
          if (!message.content?.trim() && !lastNote && run.steps.length && !run.prompted && !handsOver && step < maxSteps - 1) {
            run.prompted = true;
            run.messages.push({ role: "user", content: ANSWER_NOW });
            continue;
          }
          // A model that ends without text: the last tool note is the answer; without one it is not "done" (a bare "Done."
          // came with references picked for no answer).
          const text = message.content?.trim() || lastNote;
          const did = run.steps.filter((s) => s.ok).map((s) => s.tool);
          result = text || handsOver
            ? { status: "done", answer: text ?? "" }
            : { status: "failed", answer: did.length ? `The agent ran ${[...new Set(did)].join(", ")} but gave no answer. Run it again.` : "The agent stopped without doing anything or answering." };
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
      // Out of steps in mode "recipes" with results kept: they are handed over, no answer is written.
      if (!result && run.mode === "recipes" && Object.keys(run.raw ?? {}).length) result = { status: "done", answer: "" };
      // Out of steps: one more call with no tools, so the user gets an answer from what was found.
      if (!result) {
        run.messages.push({ role: "user", content: "No more tool calls. Answer now from what you found; say briefly what is missing." });
        const message = await llm(run.messages, usage, TOOLS, "none", run.strong ? strongModel : model).catch(() => null);
        const text = message?.content && finalText(message.content);
        run.messages.push({ role: "assistant", content: text || null });
        result = text && !LEAKED.test(text)
          ? { status: "done", answer: text }
          : { status: "failed", answer: `Stopped after ${maxSteps} steps without an answer.` };
      }
    } catch (error) {
      result = { status: "failed", answer: error.message };
    }
    // Mode "recipes": the recipes the model named, with their current raw results; what it read is never lost to a failed
    // last step (a reply that was its reasoning, the model failing at the end).
    if (run.mode === "recipes") {
      result.results = await chosenResults(run, result.answer).catch(() => []);
      if (result.results.length && result.status === "failed") result.status = "done";
      // Ids of calls that held nothing are no note for the user.
      if (!result.results.length && result.status === "done" && !String(result.answer ?? "").replace(RECIPE_ID, "").trim()) result.answer = "Nothing was found: no call held anything for this.";
    }
    // The references the answer used (in mode "recipes": those of the results handed over), with how to write at each.
    if (result.status === "done") {
      const used = run.mode === "recipes" ? refsOfResults(run, result.results) : citedRefs(result.answer, run.refs, { round: run.round });
      result.references = await withWrites(used);
      // The recipes the answer rests on: those its references came from (mode "recipes": those handed over). The request is
      // kept on them, and only on them, so the same request finds them all again with no model call (backend fast path).
      result.answer_recipes = run.mode === "recipes" ? result.results.map((r) => r.id) : [...new Set(used.map((r) => r.recipe).filter(Boolean))];
      if (ASKED_MODES.includes(run.mode) && result.answer_recipes.length && genter.recipes?.asked) {
        await genter.recipes.asked({ ids: result.answer_recipes, task: run.task }).catch((e) => console.error("genter: keeping the request on recipes failed:", e.message));
      }
    }
    run.status = result.status;
    run.updated_at = new Date().toISOString();
    // Stored without raw tool results: each one is replaced by its summary.
    const stored = { ...run, timing: undefined, seen: undefined, lists: undefined, raw: undefined, messages: run.messages.map(({ keep, ...m }) => (keep ? { ...m, content: keep } : m)) };
    await runs.put({ id: run.id, blob: seal(stored) });
    const out = {
      run_id: run.id,
      ...result,
      steps: run.steps,
      // Recipes this round executed and what happened to them (the UI shows "saved" from this, no toast).
      saved: Object.values(run.touched ?? {}),
      recipes_used: [...new Set(run.steps.flatMap((x) => [x.recipe?.id, x.from_recipe]).filter(Boolean))],
      ...(run.suggestions?.length && { suggestions: run.suggestions.map(({ label }) => ({ label })) }),
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
      let [found, connected, english] = await Promise.all([
        connecting.then((c) => genter.search({ query: task, limit: 8, apps: c.map((x) => x.toolkit), connected: true })).catch(() => []),
        connecting,
        genter.translate ? genter.translate(task) : null, // shared with search, so no second model call
      ]);
      const search_ms = Date.now() - searched;
      // The apps the task names: recipes of other apps are left out ("what's new in Google Tasks" is not a Gmail search).
      const named = namedApps(`${task} ${english?.en ?? ""}`, connected.map((c) => c.toolkit));
      const ofNamed = (r) => !named.length || !r.tool || named.some((t) => r.tool.startsWith(`${t.toUpperCase()}_`));
      found = found.filter(ofNamed);
      const recipes = found.filter((r) => r.id);
      onEvent({ type: "recipes", recipes: recipes.map(({ id, tool, title, short, summary, score, status, updated_at, checked_at, args }) => ({ id, tool, title, short, summary, score, status, updated_at, checked_at, args })) });
      const run = {
        id: randomUUID(),
        task,
        mode,
        account,
        writing: Boolean(target), // a write: the run must write, not only read
        // Active connections, so a call one account cannot see is tried on the app's others (executeOn).
        connections: connected.filter((c) => !c.status || c.status === "ACTIVE").map((c) => ({ toolkit: c.toolkit, account: c.account, alias: c.alias, default: c.default })),
        status: "running",
        created_at: new Date().toISOString(),
        apps: [...new Set(connected.map((c) => c.toolkit))],
        // No valid recipe that clearly fits: this task is new, the strong model works it out (and leaves recipes).
        strong: !recipes.some((r) => r.score >= STRONG_RECIPE),
        named, // apps the task is about
        recipes: Object.fromEntries(recipes.map((r) => [r.id, r.tool])),
        recipeArgs: Object.fromEntries(recipes.filter((r) => r.args).map((r) => [r.id, r.args])),
        steps: [],
        refs: [],
        round: 1, // each send or write is the next round; an answer with no marks falls back to its round's references
        timing: { search_ms },
      };
      const refer = (r) => register(run, r);
      const brief = briefing({ task, mode, account, found, connected, canExecute, english, named, recipeRef: (r) => recipeRef(run, r) });
      const write = target && writeNote({ ...target, n: refer(target) }, task);
      run.messages = [{ role: "user", content: write ? `${brief}\n\n${write}` : brief }];
      return loop(run);
    },

    // Continue a run: answer its question, say an app is connected, correct it, or give the next instruction.
    async send({ run_id, message }) {
      const run = await load(run_id);
      run.steps = [];
      run.writing = false; // only a write round (write, start with a target) must write
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
      run.writing = true; // this round must write
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
      steps: [{ tool, from_recipe: null, recipe: ok && out.id ? { id: out.id, created: Boolean(out.created), changed: Boolean(out.changed) } : null, ok, summary: null, saved: out.id ?? null }],
      references: place ? [place] : [],
      usage: { llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, llm_ms: 0, search_ms: 0, tool_ms: ms, model: null, ms },
    };
  }

  // A prepare task's fan-out: many independent reads over one area, a few at a time. Every success is an ordinary
  // atomic recipe; the model gets counts and the first failures, never the data.
  async function executeMany(run, input) {
    const calls = (Array.isArray(input.calls) ? input.calls : []).filter((c) => c && c.tool).slice(0, MAX_MANY);
    if (!calls.length) return { content: JSON.stringify({ error: "Pass calls: [{tool, args, account?}]" }) };
    return fanOut(run, calls, "read_many");
  }

  // The same fan-out over the items a list call of this run listed (a repository's tree, a folder's files, a calendar's
  // events): one call of `tool` per item, `args` with the item's value in `item_arg`, so the model never writes the calls
  // out (a hundred of them it cuts short, and a long list it only sees in part). Folders and what holds no text (images,
  // archives, fonts, lock files) are left out. Generic: the items, their id and the arg are whatever the list and the model say.
  async function executeEach(run, input) {
    // Its own arg names (list_id, read_tool, shared_args): with execute's tool and args the model wrote execute instead.
    const from = String(input.list_id ?? input.from ?? "").trim();
    const tool = input.read_tool ?? input.tool;
    const shared = argsObject(input.shared_args ?? input.args);
    const list = run.lists?.[from] ?? Object.values(run.lists ?? {}).at(-1); // a wrong id: the last list of the run
    if (!list) return { content: JSON.stringify({ error: "No list to read: first execute the call that lists the area's items (its whole tree, all its files), then pass its id as from." }) };
    if (!tool || !input.item_arg) return { content: JSON.stringify({ error: "Pass read_tool (the call that reads ONE item), shared_args (what every call shares) and item_arg (the arg each item's value goes in)." }) };
    const field = String(input.item_field || (list.items.some((i) => i[input.item_arg] != null) ? input.item_arg : list.id));
    const values = [...new Set(list.items.filter((i) => !isContainer(i) && !noText(i[field])).map((i) => i[field]).filter((v) => v != null && v !== ""))];
    if (!values.length) return { content: JSON.stringify({ error: `None of the ${list.items.length} listed items has a ${field} to read (folders and files with no text are left out).` }) };
    const calls = values.slice(0, MAX_EACH).map((v) => ({ tool, args: { ...shared, [input.item_arg]: v }, account: input.account }));
    const out = await fanOut(run, calls, "read_each");
    if (values.length <= MAX_EACH) return out;
    const more = `${values.length - MAX_EACH} more items were not read (at most ${MAX_EACH} per area).`;
    lastNote = `${lastNote} ${more}`;
    return { content: JSON.stringify({ ...JSON.parse(out.content), not_read: values.length - MAX_EACH, note: lastNote }) };
  }

  async function fanOut(run, calls, name) {
    const started = Date.now();
    const counts = { requested: calls.length, ok: 0, created: 0, changed: 0, unchanged: 0, failed: 0, skipped: 0 };
    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < calls.length) {
        const c = calls[next++];
        if (!isReadOnly(c.tool)) {
          counts.skipped++;
          continue;
        }
        const key = `${c.tool} ${JSON.stringify(c.args ?? {})}`;
        if (run.failed[key]) {
          counts.failed++;
          continue;
        }
        const out = await executeOn(run, { tool: c.tool, args: c.args ?? {} }, c.account).catch((e) => ({ thrown: e.message }));
        const error = out.thrown ?? (out.result?.successful === false ? out.result?.error : null);
        if (error) {
          run.failed[key] = errorText(error);
          counts.failed++;
          if (failures.length < 10) failures.push({ tool: c.tool, args: c.args, error: errorText(error).slice(0, 160) });
          run.steps.push({ tool: c.tool, from_recipe: null, recipe: null, ok: false, summary: errorText(error).slice(0, 160), saved: null });
          continue;
        }
        counts.ok++;
        if (out.created) counts.created++;
        else if (out.changed) counts.changed++;
        else counts.unchanged++;
        const recipe = out.id ? { id: out.id, created: Boolean(out.created), changed: Boolean(out.changed) } : null;
        if (recipe) (run.touched ??= {})[recipe.id] = recipe;
        run.steps.push({ tool: c.tool, from_recipe: null, recipe, ok: true, summary: null, saved: out.id ?? null });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MANY_CONCURRENCY, calls.length) }, worker));
    run.timing.tool_ms += Date.now() - started;
    run.prepared = ["requested", "ok", "created", "changed", "unchanged", "failed", "skipped"].reduce((t, k) => ({ ...t, [k]: (run.prepared?.[k] ?? 0) + counts[k] }), {});
    const note = `Prepared ${run.prepared.ok} reads: ${run.prepared.created} new recipes, ${run.prepared.changed} updated, ${run.prepared.unchanged} unchanged, ${run.prepared.failed} failed${run.prepared.skipped ? `, ${run.prepared.skipped} skipped (not reads)` : ""}.`;
    lastNote = note;
    onEvent({ type: "tool", tool: name, ok: counts.ok > 0 || !counts.failed, summary: note });
    return { content: JSON.stringify({ ...counts, ...(failures.length && { failures }), note }) };
  }

  // Mode "recipes": what the run hands over. The recipes the model named by id in its last message, best first (an id it
  // ran with other args stands for the recipe that call made); none named: every recipe this round read that held
  // something. A named recipe not run in this round (one from the first message, or read in an earlier round) is run now,
  // so every result is current; one this round ran that failed or held nothing is not run again. At most MAX_RESULTS.
  async function chosenResults(run, text) {
    const kept = Object.values(run.raw ?? {});
    const of = (id) => run.raw?.[id] ?? kept.find((r) => r.from === id);
    const ran = new Set(run.steps.flatMap((s) => [s.saved, s.from_recipe]).filter(Boolean));
    const named = [...new Set(String(text ?? "").match(RECIPE_ID) ?? [])].filter((id) => of(id) || (run.recipes?.[id] && !ran.has(id)));
    const out = [];
    for (const id of named) {
      if (out.length >= MAX_RESULTS) break;
      const r = of(id) ?? (await readNow(run, id));
      if (r && !out.includes(r)) out.push(r);
    }
    return out.length ? out : kept.slice(0, MAX_RESULTS);
  }

  // A saved recipe run for its current result, read-only. null when it may not run, fails or holds nothing.
  async function readNow(run, id) {
    const tool = run.recipes?.[id];
    if (!canExecute || !tool || !isReadOnly(tool)) return null;
    const out = await executeOn(run, { id, tool }).catch(() => null);
    if (!out || out.result?.successful === false) return null;
    const data = out.result?.data ?? null;
    if (data == null || isEmpty(data)) return null;
    const args = { ...run.recipeArgs?.[id] };
    const saved = out.id ?? id;
    const recipe = { id: saved, created: Boolean(out.created), changed: Boolean(out.changed) };
    (run.touched ??= {})[saved] = recipe;
    run.steps.push({ tool, from_recipe: id, recipe, ok: true, summary: null, saved });
    onEvent({ type: "tool", tool, recipe, ok: true, summary: null });
    const cited = refsOfResult({ app: appOf(tool, run.apps), tool, args, data }, (r) => register(run, { ...r, recipe: saved }));
    return keepRaw(run, { id: saved, from: id, tool, args, out, cited });
  }

  // A call on the account asked for, else the one this run already found the app's data on, else the default.
  // An app connected several times (two GitHub accounts): what the default cannot see (another owner's repository:
  // 404, no access) is tried on the app's other connections. The one that works is kept for the app for the rest of
  // the run, so later reads and writes there (edit_file, GENTER_WRITE) go to it too. Returns the call's result with
  // account (its alias) and accountId when another connection answered, and tried: how many connections were tried.
  async function executeOn(run, input, account) {
    const app = appOf(input.tool ?? run.recipes?.[input.id], run.apps);
    // "" or the app's own name ("github") is no connection: models send them for account.
    if (!account || account === app || run.apps?.includes(account)) account = undefined;
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

  // A file's text for the model (cut at MAX_FILE_TEXT), or a folder's entries. Not saved as a recipe: a file's
  // content is not a call to repeat, and the reference it gets says where it is. Except in mode "recipes", whose run
  // hands over recipes: there the read is saved like any call, and `saved` carries the recipe and the raw result.
  async function readFile({ run, place, account }) {
    const editor = fileEditor(place);
    if (!editor) throw new Error(`[${place.n ?? "?"}] is a ${place.app} ${place.kind}, not a file`);
    const remember = run?.mode === "recipes";
    const read = await executeOn(run ?? {}, { ...editor.read, ...(!remember && { remember: false }) }, account);
    if (read.result?.successful === false) throw new Error(`Could not read ${refLabel(place)}: ${errorText(read.result.error)}`);
    const data = read.result?.data;
    const saved = remember && read.id
      ? { id: read.id, tool: editor.read.tool, args: editor.read.args, data: data ?? null, created: Boolean(read.created), changed: Boolean(read.changed), account: read.account, instructions: read.instructions }
      : undefined;
    const entries = [data?.content, data?.items, data].find(Array.isArray);
    if (entries) {
      const names = entries.map((e) => `${e.path ?? e.name}${e.type === "dir" ? "/" : ""}`);
      return { folder: names.slice(0, 300), summary: `${refLabel(place)}: a folder of ${names.length}`, ...(read.account && { account: read.account }), saved };
    }
    const { text } = editor.file(data);
    const lines = text.split("\n").length;
    return {
      path: place.where?.path,
      lines,
      text: text.length > MAX_FILE_TEXT ? `${text.slice(0, MAX_FILE_TEXT)}\n… (truncated: ${lines} lines in all)` : text,
      summary: `read ${refLabel(place)} (${lines} lines)`,
      ...(read.account && { account: read.account }),
      saved,
    };
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
    // Committed on the account the file was read on. Read on the default one: an account that can read but not push
    // (403, no permission) gets the commit tried on the app's other connections too.
    const out = await executeOn(run ?? {}, { ...editor.write({ text, sha: file.sha, message: String(message).trim() }), remember: false }, read.accountId ?? account);
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
  out?.result?.successful === false && /not found|\b40[134]\b|forbidden|not accessible|permission|denied|push access|unauthori[sz]ed|bad credentials/i.test(errorText(out.result.error));

// The file a read_file / edit_file call means: its reference number, or owner + repo + path of a GitHub repository.
// A ref that is not a file (the commit or repository it is in) with a path: that path there.
// Empty strings are left out: models send branch: "" and account: "".
function fileRef(run, input) {
  const given = (v) => (v == null || v === "" ? undefined : v);
  const ref = given(input.ref) != null ? run.refs.find((r) => r.n === Number(String(input.ref).replace(/\D/g, ""))) : undefined;
  if (ref && (ref.kind === "file" || !given(input.path))) return ref;
  if (!given(input.path)) return undefined;
  const where = ref?.app === "github" ? ref.where ?? {} : {};
  const owner = given(input.owner) ?? where.owner;
  const repo = given(input.repo) ?? where.repo;
  return shapeRef({ app: "github", via: "call", tool: "GITHUB_GET_REPOSITORY_CONTENT", where: { owner, repo, path: String(input.path).replace(/^\/+/, ""), branch: given(input.branch) } });
}

const MAX_FILE_TEXT = 20000;

// What a list call listed, kept for read_each in this run only: { id, items } (scalars of each item, at most MAX_LISTED).
// Returns how many items it listed (0: not a list).
function keepList(run, id, data) {
  const shape = inferList(data);
  if (shape.single) return 0;
  const items = pick(data, shape.items);
  if (!Array.isArray(items) || items.length < 2) return 0;
  const flat = items.slice(0, MAX_LISTED).map((i) => Object.fromEntries(Object.entries(i ?? {}).filter(([, v]) => v == null || typeof v !== "object")));
  (run.lists ??= {})[id] = { id: shape.id, items: flat };
  return items.length;
}

// Mode "recipes": a recipe's current result as the call returned it (a list with `_ref` on its items), kept for this
// round in memory only, never stored, with the references it got: { id, tool, args, from?, account?, created, changed,
// instructions?, data, refs }. from: the recipe the model ran it as (with other args it is another recipe).
function keepRaw(run, { id, from, tool, args, out, cited }) {
  const entry = {
    id,
    tool: tool ?? null,
    args: args ?? {},
    ...(from && from !== id && { from }),
    ...(out.account && { account: out.account }),
    created: Boolean(out.created),
    changed: Boolean(out.changed),
    ...(out.instructions && { instructions: out.instructions }),
    data: cited.data ?? null,
    refs: [cited.ref, ...(cited.items ?? [])].filter((n) => n != null),
  };
  (run.raw ??= {})[id] = entry;
  return entry;
}

// The references of the results a "recipes" run hands over, in their order (each result, then the items it listed).
function refsOfResults(run, results, max = MAX_RESULT_REFS) {
  const byN = new Map((run.refs ?? []).map((r) => [r.n, r]));
  const ns = [...new Set(results.flatMap((r) => r.refs ?? []))];
  return ns.map((n) => byN.get(n)).filter(Boolean).slice(0, max);
}

const RECIPE_ID = /\brcp_\w+/g;
const MAX_RESULTS = 8; // recipes a "recipes" run hands over
const MAX_RESULT_REFS = 40;

// A folder among listed items: a tree or a directory, by its type or mime type.
const isContainer = (item) => /^(tree|dir|directory|folder)$|\.folder$/i.test(String(item?.type ?? item?.mimeType ?? item?.mime_type ?? item?.kind ?? ""));
// A file that holds no text worth a recipe, by its name: images, media, archives, fonts, binaries, lock files.
const noText = (value) =>
  typeof value === "string" && /(\.(png|jpe?g|gif|webp|ico|bmp|tiff?|heic|psd|mp[34]|mov|avi|wav|ogg|webm|zip|gz|tgz|tar|rar|7z|jar|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|class|pyc|wasm|lock)|(^|\/)(package-lock\.json|pnpm-lock\.yaml))$/i.test(value);

// A tool's args as an object: as given, or parsed from JSON text; anything else is none.
function argsObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

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

// A saved recipe as a reference: the call it makes points somewhere (its args).
const recipeRef = (run, r) =>
  r.id && r.tool
    ? register(run, { ...shapeRef({ app: appOf(r.tool, run.apps), via: "recipe", tool: r.tool, title: r.short ?? r.title, where: locatorArgs(r.args ?? {}) }), recipe: r.id })
    : undefined;

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

// Search results as the model sees them: recipes (which call to make: their summary is what that call returned when it
// was last saved, not the current value) with their reference number, Composio tools with a compact arg schema.
function compactFound(r, ref) {
  if (r.id) {
    return {
      ref, id: r.id, tool: r.tool, args: r.args, title: r.title,
      last_result: r.summary, ...(r.matched && { result_matched: r.matched }),
      updated_at: r.updated_at, checked_at: r.checked_at, ...(r.partial && { partial: true }), score: r.score,
    };
  }
  // A piece of a skill not read before: its args are fixed values, not a schema.
  if (r.kind === "skill") return { tool: r.tool, title: r.title, description: (r.description ?? "").slice(0, 300), args: r.args, score: r.score };
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

// An answer that hands the work back to the user instead of doing it.
const ASKS = /\?\s*$|let me know|which (one|tool|account)|would you like|do you want|please (specify|clarify|confirm|provide)|уточни|какой из|какую из|хотите ли|подскажите|выберите/i;
const NO_QUESTIONS =
  "Do not ask the user. Do the task now with the most likely reading: find the tool (search_tools with the app name and the action), " +
  "run it, and answer from the result; say in one line what you assumed.";

// An answer that says a part cannot be done for want of a tool, without the tool having been tried.
const GIVES_UP =
  /нет (подходящ\S* |нужн\S* |такого |такой )?(инструмент|команд|функци)|не (могу|можем|удалось|получилось|смог\S*) (напрямую )?(прочитать|получить|показать|открыть|достать)|no (suitable |such |available )?(tool|command)|(cannot|can't|can not|unable to|could not|couldn't|not able to) (directly )?(read|retrieve|access|get|fetch|open|show)/i;
const NO_GIVING_UP =
  "Do not give up on a part of the task: a connected app always has tools. A file of a repository is read with read_file " +
  "(ref, or owner + repo + path + branch; a folder gives its entries). For anything else search_tools with the app name and the action, " +
  "run the closest tool, then answer the whole task. Say it cannot be done only after a call for it failed, with that error.";

const ANSWER_NOW =
  "You ended without an answer. If a part of the task is not done yet, do it now; otherwise answer the whole task from the results above, with their ref numbers.";

const NOTHING_WRITTEN =
  "Nothing has been written yet: no commit and no write call worked in this round. Do the change now (edit_file for a file, " +
  "the write tool otherwise), then answer with what was written and its link. If it cannot be done, say exactly why.";

// gpt-oss (harmony) now and then gets its channels back as text, when the provider does not parse them: "analysisWe
// need… assistantcommentary to=functions.execute json{"tool": …}" came as the answer of a calendar question. A call
// written that way is made as a call; the final channel ("…assistantfinal<answer>") is the answer; the rest is reasoning.
// A slug the model called as a function (GOOGLECALENDAR_FIND_EVENT {…}) is an execute of it.
export function asCalls(message, prefix = "call") {
  let calls = message.tool_calls ?? [];
  let content = message.content ?? null;
  if (!calls.length && typeof content === "string" && content.includes("to=functions.")) {
    calls = writtenCalls(content).map((c, i) => ({ id: `${prefix}_${i}`, type: "function", function: c }));
    if (calls.length) content = null;
  }
  if (typeof content === "string") content = finalText(content);
  calls = calls.map((tc) => {
    const name = String(tc.function?.name ?? "").replace(/^functions\./, "").replace(/<\|.*$/s, "").trim();
    if (TOOL_NAMES.has(name) || !/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name)) return name === tc.function?.name ? tc : { ...tc, function: { ...tc.function, name } };
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {}
    const wrapped = args && typeof args.args === "object" && Object.keys(args).every((k) => ["args", "account", "description", "short", "tags"].includes(k));
    return { ...tc, function: { name: "execute", arguments: JSON.stringify(wrapped ? { ...args, tool: name } : { tool: name, args }) } };
  });
  return { ...message, content, ...(calls.length ? { tool_calls: calls } : { tool_calls: undefined }) };
}

// The calls in harmony text: "to=functions.<name>" and the JSON object after it.
function writtenCalls(text) {
  const out = [];
  for (const m of text.matchAll(/to=functions\.([A-Za-z0-9_]+)/g)) {
    const start = text.indexOf("{", m.index);
    const next = text.indexOf("to=functions.", m.index + 1);
    if (start < 0 || (next >= 0 && start > next)) continue;
    const json = objectAt(text, start);
    try {
      if (json) out.push({ name: m[1], arguments: JSON.stringify(JSON.parse(json)) });
    } catch {}
  }
  return out;
}

// The balanced {...} that starts at i (strings and escapes respected), or null.
function objectAt(text, i) {
  let depth = 0;
  let quoted = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (quoted) {
      if (ch === "\\") j++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(i, j + 1);
  }
  return null;
}

// The answer of a harmony text: what follows its last final channel, without special tokens.
function finalText(text) {
  const at = text.lastIndexOf("assistantfinal");
  const final = at >= 0 ? text.slice(at + "assistantfinal".length) : text;
  return final.replace(/<\|[a-z_]+\|>/g, "").trim();
}

// Reasoning or a call written as text, not an answer.
const LEAKED = /^analysis[A-Z]|assistant(commentary|analysis)|\bto=functions\.|<\|(channel|message|call|start|end)\|>/;
const NOT_AN_ANSWER =
  "Your last message was your reasoning or a tool call written as text, not a call and not an answer. " +
  "Call the tool now with a real tool call (execute {tool: <slug>, args}), or answer the task.";

// A tool that keeps failing is stopped after this many failures in one round, so a run never spins on it.
const MAX_TOOL_FAILURES = 3;
const MAX_SEARCHES = 3;
const READ_ONLY_MODES = ["find", "recipes", "prepare", "event"];
// Modes whose task is a person's request (not a prepare or event instruction): it is kept on the recipes the answer used.
const ASKED_MODES = ["run", "find", "recipes"];
const MAX_MANY = 100;
const MAX_EACH = 300; // calls one read_each makes: an area bigger than that is read in part, and the note says how much is left
const MAX_LISTED = 2000;
const MANY_CONCURRENCY = 4;
const STRONG_RECIPE = 0.45; // a recipe this close to the task is known ground: the fast model is enough

function briefing({ task, mode, account, found, connected, canExecute, english, named = [], recipeRef = () => undefined }) {
  const recipes = found.filter((r) => r.id).map((r) => compactFound(r, recipeRef(r)));
  const tools = found.filter((r) => !r.id).map((r) => compactFound(r));
  const apps = connected.map((c) => `${c.toolkit}${c.alias ? ` (${c.alias}${c.default ? ", default" : ""})` : ""}${c.status && c.status !== "ACTIVE" ? ` [${c.status}]` : ""}`);
  return [
    `Task: ${task}`,
    english?.en && `In English: ${english.en}`,
    english?.terms?.length && `Search terms for keyword filters (use both languages, joined with OR): ${english.terms.join(" | ")}`,
    MODE_NOTES[mode] ?? MODE_NOTES.run,
    !canExecute && "This user cannot run tools: answer from recipe summaries, or say which tool and args would do it.",
    account && `Use connection: ${account}`,
    `Connected apps: ${apps.join(", ") || "none"}`,
    named.length && `The task is about ${named.join(", ")}: read the user's data there with its tools (search_tools "${named[0]} ..." if none below fits), not other apps.`,
    `Saved recipes matching the task (each is a call that worked before; last_result is what it returned then, not what is there now):\n${recipes.length ? JSON.stringify(recipes) : "none"}`,
    tools.length && `Candidate Composio tools:\n${JSON.stringify(tools)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const MODE_NOTES = {
  find: "Mode: find (read-only: answer the question; only execute tools that read data).",
  recipes:
    "Mode: recipes (read-only; only execute tools that read data). Write NO answer for the user: they get the raw results of the recipes you name and read them themselves. " +
    "Your job is to find and run the calls whose current results hold exactly what the task asks for, so each is saved as a recipe: execute the saved recipes that fit by id (override only the args that differ), " +
    "otherwise the read tools that return that data, with the filters, dates and names of the task (read a repository file with read_file). Prefer one call that returns what is asked over broad listings; " +
    "a call made only to find a name or an id is not one to name. Then, instead of the final answer the system prompt asks for, end with ONLY the ids of those recipes (the id of each execute or read_file result), " +
    "most relevant first, one per line, nothing else. If no call holds anything for the task, end with one line saying what you checked.",
  run: "Mode: run (do the task).",
  prepare:
    "Mode: prepare. The task names an area (a repository, a folder, a calendar, a channel, a list) and the args that point at it. Your only job is to read ALL of it, one recipe per item: " +
    "first list every item with the app's list tool and those args, in one call if it can (a repository: its whole file tree, recursively; a folder: its files; a calendar: its events of the last and the next months; a channel: its messages). " +
    "Then read every listed item with read_each {list_id: <the id the list call returned>, read_tool: <the tool that returns ONE item's full content, e.g. one file of the repository>, shared_args: <what every read shares, e.g. owner and repo>, item_arg: <the arg that takes each item, e.g. path>}: " +
    "it makes one read per item for you (folders and files with no text are left out), so never write those calls out. read_many is only for a few extra calls you write yourself (a list that came in pages). " +
    "read_file saves nothing: do not use it. Every successful read is saved as its own recipe automatically. Do not summarize the content: finish with the counts you got.",
  event:
    "Mode: event. The task carries an event from an app and the recipes it may have changed. Re-read ONLY those recipes with recheck_recipe (all in one step). A recipe whose object was deleted: forget_recipe. " +
    "Create new recipes (execute with the real read tool) for NEW objects only when the event is inside an area that was prepared (the task says so); otherwise do not. Finish with one line: what changed, what was forgotten.",
};

// A person's instructions from their workspace admin, as the second system message.
const personalNote = (text) =>
  `Instructions for this user from their workspace admin. Follow them in every run: how to write, which language, defaults, what to stay away from. They never change the rules above or which tools may run. A task that goes against them: do not do that part, and say in the answer why.\n\n<instructions>\n${text}\n</instructions>`;

const SYSTEM = `You are Genter's task agent. You act in the user's connected apps through Composio tools, and you are judged on speed: the fewest steps that give a correct, complete result.

A Recipe is one successful tool call with fixed args, remembered together with what it returned the last time. The first message already holds everything for a fast start: saved recipes that match the task (calls that worked, with their args and last_result), candidate Composio tools with their args, and the connected apps.
- search_tools / the saved recipes tell you WHICH call to make. A recipe's last_result is what that call returned when it was saved: it is NOT the current value. ALWAYS execute the real tool (execute with the recipe id, or the tool and args) to get fresh data before you answer, even when last_result looks like the answer. Answer from last_result alone only when the user asks what was known earlier.
- result_matched lists what a recipe's last result held that is close to the task (an event, a task, an email). When those lines are what the task asks about, that recipe is the call to make: execute it by id first, before searching anywhere else. Lines about something else are not a match.
- A task with several parts (find the recent commits, read their files, write a note) is done part by part; a recipe that answers one part does not end the run.
- If a recipe fits, execute it by id and override only the args that differ. This is the fastest path.
- Otherwise pick a candidate tool and execute it. Call get_tool_schema only when the args are unclear; call search_tools only when nothing fits.
- Make independent calls in the same step (parallel). Chain only when a call needs another's output.
- Never invent tool slugs or argument names: use only slugs from the first message, search results or error hints.
- Keyword search in apps (Gmail q, Slack, Drive, Notion, GitHub search) matches literal words, and the data is often in another language than the request (English emails, Russian request). Put the key terms in both languages in one query, joined with OR, e.g. Gmail: ("объединенные знания" OR "unified knowledge" OR "merged knowledge"). The first message lists the terms.
- A failed call is not retried with the same args. "Not Found" from an app means the repo, file or id is wrong, not the tool: find the real one (list the user's repos, search) instead of guessing. After two failures of a tool, answer with what you have.
- A connected app always has tools: never answer that there is no tool for it. If no candidate fits, search_tools with the app name and what to do (e.g. "Google Tasks list tasks"), then execute.
- A candidate with kind "skill" (or a recipe of SKILL_READ_CHUNK) is one section of a skill, a written how-to: execute it with exactly its args and follow what it says. The result names the files it points to (related, each with the call that gets it); fetch only those you need. A script is code Genter does not run: read it, never claim it was run.
- A name you do not know (an org, a project, a repo, a person): look it up in the connected apps first (e.g. the user's GitHub repositories and orgs) and answer about what you found. "Projects" in GitHub usually means repositories: list them (and Projects only if asked).
- "What's new in <app>" / "что нового в <app>" for a connected app means the user's own latest items there (recently created or updated tasks, issues, emails, files), read with that app's tools, not news about the product.
- Every fact in the answer comes from a tool result of this run (a recipe's last_result only says what to call). Never answer from general knowledge about a product or company; if nothing was found, say what was checked.
- Cite where each fact comes from: right after it, the ref number of the recipe, tool result or list item (its _ref) in square brackets, e.g. "Paging stops at a short page [3]." or "[2, 5]". Cite only what you used; never invent numbers. The user gets the cited places (paths, links, ids) with the answer.
- To read a file of a repository (its text) or a folder (its entries), call read_file with owner, repo, path (and branch), or the file's ref; several files: several read_file calls in one step. Never answer that a file cannot be read before read_file failed on it.
- The files a GitHub commit changed: GITHUB_GET_A_COMMIT {owner, repo, ref: <sha>} (its files[].filename), then read_file for each.
- Never show a file's text, a commit's files or any other content that no call of this run returned: read it first.
- To change an existing file of a repository, call edit_file with exact pieces of its current text and what goes instead: it reads and commits the file for you. Never write a whole existing file out; GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS is for new files.
- An empty result is not an answer: retry once with translated or broader terms before saying nothing was found. Neither is a result whose items only share a word with the request (a GitHub notification that says "clean up" for "when do I clean"): say it holds nothing about the task and look where it would be (calendar, tasks).
- Every successful call is saved as a recipe automatically (the same call updates the same recipe; a failed call saves nothing). Do not describe or name recipes: just make the calls that answer the task. A result that is only a page (next-page marker, truncated) is a partial result: say so, never claim totals or absence from it.
- When you discover a finite area the user may want kept ready (a repository's files, a Drive folder, a channel), call suggest_prepare {label, why} once, and carry on with the task: it has no side effects.
- An app the task needs is not connected: call connect_app and stop.
- Never ask the user anything and never end with a question or a choice for them. Ambiguous: take the most likely reading (the default account, the latest, all of them, the closest name), do it, and say in one line what you assumed. Only an irreversible action (delete, send, pay) on a target you cannot pin down is not done: say what was not done and why.
- An app is connected several times: pass account (alias or id) when the user names one; otherwise the default is used, and a call the default cannot see (another owner's repo: not found, no access) is retried on the app's other connections by itself. A result with account says which connection had it: say so in the answer. Not found on every account means the name is wrong, not the account.
Always end with an answer built from what you found, even partial; never "I can't" while a tool could still be tried.
Final answer: short and concrete, in the user's language. Include the names, ids and links needed to open or continue the result. Say what was done, not how.`;

// A tool's args, whatever they are. No `type`: a provider that decodes tool calls by the schema (Groq, the quickest for
// gpt-oss) writes an object with no listed properties as {} whatever the model meant, so every call went out without its args.
const FREE_ARGS = { description: 'The tool\'s arguments as a JSON object, e.g. {"owner": "o", "repo": "r", "path": "README.md"}' };

const TOOLS = [
  {
    name: "execute",
    description: "Run a Composio tool for real: `tool` + `args`, or `id` of a saved recipe (args override its args). Returns the current result data and the id of the recipe it is saved as (saved or updated automatically).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Saved recipe id" },
        tool: { type: "string", description: "Tool slug, e.g. GMAIL_FETCH_EMAILS" },
        args: FREE_ARGS,
        account: { type: "string", description: "Connection alias or id when the app is connected several times" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file of a GitHub repository (its text) or a folder (its entries). Use it for every file read; it gets a reference number to cite and to edit.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The file's reference number" },
        owner: { type: "string", description: "Without ref: the repository owner" },
        repo: { type: "string" },
        path: { type: "string", description: "Path in the repository, e.g. src/agent.js" },
        branch: { type: "string", description: "Branch, tag or commit sha; the default branch when left out" },
        account: { type: "string" },
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
    description: "Search saved recipes (by what their results meant) and Composio tools. Only when nothing in the first message fits. A recipe found says which call to make; execute it for fresh data.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_tool_schema",
    description: "Full argument schemas for up to 5 tool slugs.",
    parameters: { type: "object", properties: { tools: { type: "array", items: { type: "string" } } }, required: ["tools"] },
  },
  {
    name: "suggest_prepare",
    description: "Suggest that the user prepares a whole area (a repository, a folder, a channel) so it is found faster next time. No side effects: only a suggestion shown with the answer.",
    parameters: {
      type: "object",
      properties: { label: { type: "string", description: "The area, e.g. 'Entire repository Genterai/genter-cli'" }, why: { type: "string" } },
      required: ["label"],
    },
  },
  {
    name: "read_many",
    description: "Prepare task only: run up to 100 independent READ calls, 4 at a time. Each success is saved as its own recipe. Returns counts and the first failures, not data.",
    parameters: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: { tool: { type: "string" }, args: FREE_ARGS, account: { type: "string" } },
            required: ["tool"],
          },
        },
      },
      required: ["calls"],
    },
  },
  {
    name: "read_each",
    description:
      "Prepare task only: read every item a list call of this run listed, one READ call per item (folders and files with no text left out, 4 at a time, up to 300). " +
      "Each success is saved as its own recipe. Returns counts and the first failures, not data.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "The id the list call returned (its recipe id)" },
        read_tool: { type: "string", description: "The tool that reads ONE item, e.g. GITHUB_GET_REPOSITORY_CONTENT" },
        shared_args: { description: 'The args every read shares, as a JSON object, e.g. {"owner": "o", "repo": "r"}' },
        item_arg: { type: "string", description: "The arg each item's value goes in, e.g. path, file_id, event_id" },
        item_field: { type: "string", description: "The item's field that holds that value, when it is not named like item_arg (e.g. id)" },
        account: { type: "string" },
      },
      required: ["list_id", "read_tool", "item_arg"],
    },
  },
  {
    name: "recheck_recipe",
    description: "Event task: run a saved recipe's call again. The recipe is updated only if its result changed. Returns { status: fresh | gone | denied | failed, changed }.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "forget_recipe",
    description: "Event task: the object a recipe reads was deleted. Marks it gone: it is never offered as current again.",
    parameters: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] },
  },
  {
    name: "connect_app",
    description: "Create a link for the user to connect an app (toolkit slug like gmail, github, slack). Stops the run until they connect it.",
    parameters: { type: "object", properties: { toolkit: { type: "string" }, alias: { type: "string" } }, required: ["toolkit"] },
  },
].map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));

// Which tools a mode offers: read_many and read_each only prepare an area, recheck / forget only answer an event.
const MODE_ONLY = { read_many: ["prepare"], read_each: ["prepare"], recheck_recipe: ["event"], forget_recipe: ["event"] };
const TOOLSETS = Object.fromEntries(["run", "find", "recipes", "prepare", "event"].map((mode) => [mode, TOOLS.filter((t) => !MODE_ONLY[t.function.name] || MODE_ONLY[t.function.name].includes(mode))]));
const toolsFor = (mode) => TOOLSETS[mode] ?? TOOLSETS.run;
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
