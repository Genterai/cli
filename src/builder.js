import { BUILTIN, fill, inferList, inferText, matches, pick } from "./sync.js";

const FILE_EXCLUDE = BUILTIN.github.exclude;

// The live sync builder: a model (BUILDER_MODEL, default openai/gpt-6-luna) that writes a live sync recipe for any app from its tools.
// It explores the tools (search, schemas, real sample calls), writes the recipe, tests it on real data and fixes it
// until the test passes, then saves it like any recipe. Building is rare and the result is reused.
export function createBuilder({ genter, openrouterApiKey, model = process.env.BUILDER_MODEL || "openai/gpt-6-luna", maxSteps = 20, onEvent = () => {} }) {
  async function llm(messages) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM }, ...messages], tools: TOOLS, temperature: 0, usage: { include: true } }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Builder model failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { message: data.choices[0].message, cost: data.usage?.cost ?? 0 };
  }

  async function call(name, input, ctx) {
    switch (name) {
      case "search_tools": {
        const found = await genter.search({ query: input.query, limit: 8 });
        return found.filter((r) => !r.id).map((r) => ({ tool: r.tool, description: String(r.description ?? "").slice(0, 300) }));
      }
      case "get_tool_schema":
        return Promise.all((input.tools ?? []).slice(0, 5).map((t) => genter.schema(t).catch((e) => ({ tool: t, error: e.message }))));
      case "try_tool":
        return genter.sources.probe({ tool: input.tool, args: input.args ?? {}, account: ctx.account });
      case "list_triggers":
        return genter.trigger_types({ toolkit: input.toolkit });
      case "test_live_sync":
        return genter.sources.test({ recipe: input.recipe, scope: input.scope ?? {}, account: ctx.account });
      case "save_live_sync": {
        const out = await genter.save_live_sync({ ...input, account: ctx.account });
        if (out.saved) ctx.saved = { id: out.id, scope: input.scope ?? {}, recipe: input.recipe, test: out.test };
        return out;
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  }

  // JSON from the model, in one call.
  async function ask(content) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, response_format: { type: "json_object" }, messages: [{ role: "user", content }], usage: { include: true } }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Planner failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { json: JSON.parse(data.choices[0].message.content), cost: data.usage?.cost ?? 0 };
  }

  // What an app can keep as knowledge, planned by a model from the app's read tools in one call:
  // [{ name, description, recommended, containers?: { tool, args, max? }, items: { tool, args, where?, skip?, next?, url? }, read?: { tool, args } }].
  async function plan(toolkit) {
    const tools = await genter.app_tools({ toolkit });
    const { json, cost } = await ask(
      `These are the read tools of ${toolkit}, called as the connected person. Plan what they would want to keep as searchable ` +
        "knowledge: THEIR OWN data (their repos' files, issues and pull requests, their emails, events, rows, tasks, messages, " +
        "documents...), up to 8 kinds, most useful first. Never a global or public search (all of GitHub, all of Twitter): reach " +
        "their data through tools that list what belongs to them, or a search scoped to them.\n" +
        "When the content lives in containers (repositories, projects, labels, calendars, spreadsheets, task lists, channels, " +
        "boards, teams, folders), give a containers call that lists the person's containers (most recently active first) and " +
        "an items call that lists ALL the content of one container: every page, every state (open and closed), the whole tree " +
        '(recursive). In its args "{{container.<path>}}" is a field of one container as the containers call returns it, e.g. ' +
        '{"owner": "{{container.owner.login}}", "repo": "{{container.name}}", "tree_sha": "{{container.default_branch}}"}. ' +
        "Each container becomes a recipe of its own that keeps all of it up to date.\n" +
        'When the items call returns no text (a file tree, ids only), add a read call for one item, with "{{item.<path>}}" for ' +
        "the item's fields, plus container fields as above. items.where keeps only items whose paths equal values " +
        '(e.g. {"type": "blob"} for files in a tree); items.skip drops items where any path equals its value, \"*\" = the path is there ' +
        '(GitHub lists pull requests among issues: skip {"pull_request": "*"}). Pagination: put "{{page}}" in the page or cursor ' +
        'arg; numbered pages need nothing more, a cursor needs items.next = the path to the next cursor in the response. items.url (optional) is a link template, e.g. ' +
        '"https://github.com/{{container.full_name}}/blob/{{container.default_branch}}/{{item.path}}".\n' +
        "Use only these tools and their argument names; ask for the largest page size. Kinds must not overlap. Mark " +
        "recommended: true on the ones most people want kept. Streams (mail, chat, posts) take recent items only.\n" +
        'Reply with JSON only: {"kinds": [{"name": "Files", "description": "...", "recommended": true, ' +
        '"containers": {"tool": "...", "args": {}}, "items": {"tool": "...", "args": {...}, "where": {...}}, "read": {"tool": "...", "args": {...}}}]} ' +
        "(containers and read are optional).\n\n" +
        JSON.stringify(tools),
    );
    return { kinds: (json.kinds ?? []).filter((k) => k?.items?.tool).slice(0, 8), cost };
  }

  // The plan of an app is about the app, not the person: cached for a day, shared by everyone in the process.
  function planOf(toolkit) {
    if (PLANS[toolkit]) return Promise.resolve({ kinds: structuredClone(PLANS[toolkit]), cost: 0 });
    const hit = plans.get(toolkit);
    if (hit && Date.now() - hit.at < 86_400_000) return hit.plan.then(({ kinds }) => ({ kinds: structuredClone(kinds), cost: 0 }));
    const p = plan(toolkit);
    plans.set(toolkit, { at: Date.now(), plan: p });
    p.catch(() => plans.delete(toolkit));
    return p;
  }

  // Args fixed by the model once, from a real container and the error the first try gave.
  async function repair(kind, container, error) {
    const schemas = await Promise.all(
      [kind.items.tool, kind.read?.tool].filter(Boolean).map((t) => genter.schema(t).catch(() => ({ tool: t }))),
    );
    const { json, cost } = await ask(
      `A sync of "${kind.name}" calls ${kind.items.tool} once per container; a container is one item of ${kind.containers.tool}. ` +
        `With these args it failed: ${String(error).slice(0, 400)}\n` +
        `Args: ${JSON.stringify({ items: kind.items.args, read: kind.read?.args })}\n` +
        `A real container: ${clip(container)}\nSchemas: ${clip(schemas, 6000)}\n` +
        'Fix the args. "{{container.<path>}}" is a field of the container (paths as in the real one), "{{item.<path>}}" a field ' +
        'of an item. Reply with JSON only: {"items": {...args}, "read": {...args} | null}.',
    );
    return {
      kind: { ...kind, items: { ...kind.items, args: json.items ?? kind.items.args }, ...(kind.read && { read: { ...kind.read, args: json.read ?? kind.read.args } }) },
      cost,
    };
  }

  // A planned kind for one container (or none): its items call run for real once, shaped with inferList (and
  // inferText for its read call), with an estimate of how much a sync of it does.
  async function shape(toolkit, kind, container, account, triggers) {
    const ctx = container ? { container: container.raw } : {};
    const args = fillContainer(kind.items.args ?? {}, ctx);
    // Pages: a cursor at items.next, or numbered pages when {{page}} is in the args without one.
    const paged = JSON.stringify(args).includes("{{page}}");
    const next = paged && kind.items.next ? { next: kind.items.next } : paged ? { nextPage: true } : {};
    const res = await genter.sources.probe({ tool: kind.items.tool, args: fill(args, { page: next.nextPage ? 1 : undefined }), account, raw: true });
    if (res?.successful === false) throw new Error(`${kind.items.tool}: ${JSON.stringify(res.error).slice(0, 300)}`);
    const shape = inferList(res);
    const filters = Object.fromEntries(["where", "skip"].filter((k) => kind.items[k] && Object.keys(kind.items[k]).length).map((k) => [k, kind.items[k]]));
    const list = { tool: kind.items.tool, args, ...shape, ...next, ...filters };
    if (kind.items.url) list.url = fillContainer(kind.items.url, ctx);
    let read;
    if (kind.read?.tool && !shape.single) {
      const first = [pick(res, shape.items)].flat().find((x) => x && matches(x, filters));
      if (!first) throw new Error("no items to read");
      const readArgs = fillContainer(kind.read.args ?? {}, ctx);
      const sample = await genter.sources.probe({ tool: kind.read.tool, args: fill(readArgs, { item: { ...first, id: pick(first, shape.id) } }), account, raw: true });
      if (sample?.successful === false) throw new Error(`${kind.read.tool}: ${JSON.stringify(sample.error).slice(0, 300)}`);
      const text = inferText(sample);
      if (!text) throw new Error(`${kind.read.tool} returned no text`);
      read = { tool: kind.read.tool, args: readArgs, ...text };
      delete list.text;
    }
    if (shape.version && shape.version === shape.id) list.append = true;
    const label = container?.label;
    const name = label ? `${label} · ${kind.name}` : kind.name;
    const recipe = {
      name,
      toolkit,
      description: label ? `${kind.description ?? kind.name} — ${label}` : (kind.description ?? kind.name),
      title: name,
      recommended: Boolean(kind.recommended),
      scope: {},
      list,
      ...(read && { read, exclude: FILE_EXCLUDE, maxSize: 300_000 }),
      // The connected account it was made from: Live sync runs on it, not on the app's default one.
      ...(account && { account }),
      triggers,
      every: triggers.length ? null : 60,
    };
    recipe.estimate = estimate(recipe, res, shape);
    return recipe;
  }

  // How much a sync of a recipe does, from its first real page — no prices: items, calls to the app, model work.
  // level: light (a few calls), medium, heavy (hundreds of calls or more on the first sync).
  function estimate(recipe, res, shape) {
    const list = recipe.list;
    const found = shape.single ? [res] : [pick(res, shape.items)].flat().filter(Boolean);
    const keep = shape.single ? found : found.filter((x) => matches(x, list));
    const exclude = (recipe.exclude ?? []).map((x) => new RegExp(x, "i"));
    const items = keep.filter((x) => !exclude.some((re) => re.test(String(pick(x, shape.id) ?? "")))).filter((x) => !(recipe.maxSize && x.size > recipe.maxSize)).length;
    // More pages: a cursor came back, or a numbered first page came back full (a page of 100 or more).
    const more = Boolean(list.next ? pick(res, list.next) : list.nextPage && found.length >= 100);
    const reads = recipe.read ? items : 0;
    const first = (list.nextPage ? 2 : 1) + reads;
    return {
      items,
      more, // more pages than the first: at least this many
      calls_first: first, // calls to the app on the first sync (at least, when there are more pages)
      calls_next: list.nextPage ? 2 : 1, // a later sync lists again (numbered pages end on an empty one) and reads only what changed
      reads_per_item: Boolean(recipe.read),
      level: first > 200 || (more && recipe.read) ? "heavy" : first > 20 || more ? "medium" : "light",
    };
  }

  // Triggers picked once per kind (on its first container) and moved onto the others: config values that came from
  // the first container's args are taken from the same args of each other one.
  function retarget(triggers, firstArgs, args) {
    const map = new Map(Object.entries(firstArgs).filter(([, v]) => typeof v === "string").map(([k, v]) => [v, k]));
    return triggers.map((t) => ({
      ...t,
      config: Object.fromEntries(Object.entries(t.config ?? {}).map(([k, v]) => [k, map.has(v) ? args[map.get(v)] : v])),
    }));
  }

  // The containers of a kind: [{ id, label, raw }], as many as the plan says (default 20).
  async function containersOf(kind, account) {
    // The first page: an empty {{page}} drops the argument (a literal "{{page}}" made GitHub reject the call).
    const res = await genter.sources.probe({ tool: kind.containers.tool, args: fill(kind.containers.args ?? {}, {}), account, raw: true });
    if (res?.successful === false) throw new Error(`${kind.containers.tool}: ${JSON.stringify(res.error).slice(0, 200)}`);
    const shape = inferList(res);
    if (!shape.items) throw new Error("no containers found");
    const skip = (x) => x.archived === true || x.disabled === true || x.in_trash === true;
    return [pick(res, shape.items)]
      .flat()
      .filter((x) => x && !skip(x))
      .slice(0, Math.min(Number(kind.containers.max) || 10, 50)) // the most active first; more on request
      .map((raw) => ({ id: String(pick(raw, shape.id)), label: String(pick(raw, ["full_name", ...[shape.title].flat()]) ?? pick(raw, shape.id)), raw }));
  }

  // One kind: a recipe per container (or one without containers), each tested and saved.
  // run: { deadline, done: Set of recipe names already handled, left }: containers past the deadline are left
  // for the next round, and the kind comes back with what it settled (repaired args, triggers) for that round.
  async function discoverKind(toolkit, kind, account, onProgress, known, run) {
    let cost = 0;
    const made = [];
    const nameOf = (container) => (container ? `${container.label} · ${kind.name}` : kind.name);
    const late = () => Date.now() > run.deadline;
    const save = async (recipe, container) => {
      const { estimate: e } = recipe;
      const name = nameOf(container);
      // Nothing there yet (a repo without issues): no recipe; Set up sync again picks it up once there is.
      if (!e.items && !e.more) return onProgress({ kind: kind.name, container: container?.label ?? null, name, empty: true });
      // Set up sync again replaces the recipe of the same name instead of adding another.
      const id = known.get(recipe.name);
      const out = await genter.save_live_sync({
        ...(id && { id }),
        recipe,
        description: recipe.description,
        short: recipe.description,
        tags: [toolkit, kind.name, ...(container ? [container.label] : [])],
        account,
      });
      if (!out.saved) throw new Error((out.test?.problems ?? ["test failed"]).join("; "));
      made.push(out.id);
      onProgress({ kind: kind.name, container: container?.label ?? null, name, recipe: out.id, estimate: e });
    };
    const failed = (container, e) => onProgress({ kind: kind.name, container: container?.label ?? null, name: nameOf(container), error: e.message });
    if (!kind.containers?.tool) {
      if (run.done.has(nameOf(null))) return { made, cost, kind };
      if (late()) return run.left++, { made, cost, kind };
      await within(STEP_MS, async () => {
        const triggers = await genter.pick_triggers({ toolkit, tool: kind.items.tool, args: kind.items.args ?? {}, description: kind.description });
        await save(await shape(toolkit, kind, null, account, triggers));
      }).catch((e) => failed(null, e));
      return { made, cost, kind };
    }
    const all = await within(STEP_MS, () => containersOf(kind, account));
    if (!all.length) throw new Error("nothing to keep: no containers");
    onProgress({ kind: kind.name, containers: all.map((c) => c.label) });
    const todo = all.filter((c) => !run.done.has(nameOf(c)));
    if (!todo.length) return { made, cost, kind };
    // The first container settles the args (repaired once if they fail) and the triggers; the others reuse them.
    // A later round has them in kind.settled already.
    let rest = todo;
    if (!kind.settled) {
      if (late()) return (run.left += todo.length), { made, cost, kind };
      const [first] = todo;
      rest = todo.slice(1);
      try {
        await within(STEP_MS * 2, async () => {
          let firstRecipe;
          try {
            firstRecipe = await shape(toolkit, kind, first, account, []);
          } catch (e) {
            const fixed = await repair(kind, first.raw, e.message);
            cost += fixed.cost;
            kind = fixed.kind;
            firstRecipe = await shape(toolkit, kind, first, account, []);
          }
          const triggers = await genter.pick_triggers({ toolkit, tool: kind.items.tool, args: firstRecipe.list.args, description: kind.description });
          kind = { ...kind, settled: { triggers, args: firstRecipe.list.args } };
          firstRecipe.triggers = triggers;
          firstRecipe.every = triggers.length ? null : 60;
          await save(firstRecipe, first);
        });
      } catch (e) {
        failed(first, e);
        if (!kind.settled) {
          // The first container could not settle the kind: the others would fail the same way.
          rest.forEach((c) => failed(c, new Error(`skipped: ${String(e.message).slice(0, 120)}`)));
          return { made, cost, kind };
        }
      }
    }
    const { triggers, args } = kind.settled;
    await pool(rest, 4, async (c) => {
      if (late()) return run.left++;
      try {
        await within(STEP_MS, async () => {
          const recipe = await shape(toolkit, kind, c, account, []);
          recipe.triggers = retarget(triggers, args, recipe.list.args);
          recipe.every = triggers.length ? null : 60;
          await save(recipe, c);
        });
      } catch (e) {
        failed(c, e);
      }
    });
    return { made, cost, kind };
  }

  return {
    // Everything an app can keep as knowledge, as live sync recipes: a model plans the kinds of the person's own data
    // (files, issues, pull requests...); a kind that lives in containers (repositories, projects, channels) becomes a
    // recipe per container, each listing ALL of that container (every page, the whole tree) so a sync keeps all of it
    // up to date and reads only what changed. Every recipe is shaped from real responses, tested, saved, and carries
    // an estimate of how much its sync does. onProgress gets { planned }, { kind, containers },
    // then { kind, container, name, recipe, estimate }, { kind, container, name, empty } or { kind, container?, name?, error }.
    // It works in rounds: nothing new starts after budgetMs, and { left } says how much is still to do. The next
    // round passes the returned kinds (the plan with what it settled) and done (names handled so far).
    // kinds (optional): a plan to use instead of planning one; the plan of an app is cached for a day.
    async discover({ toolkit, account, kinds: given, done = [], budgetMs = 200_000, onProgress = () => {} }) {
      const started = Date.now();
      const planned = given ? { kinds: given, cost: 0 } : await planOf(toolkit);
      // Recommended kinds first, so what most people want appears first.
      let kinds = [...planned.kinds].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
      const known = new Map(((await genter.sources.templates().catch(() => [])) ?? []).filter((t) => !t.builtin && t.toolkit === toolkit).map((t) => [t.name, t.template]));
      let cost = planned.cost;
      onProgress({ planned: kinds.map((k) => ({ name: k.name, description: k.description, recommended: Boolean(k.recommended), per_container: Boolean(k.containers?.tool) })), kinds });
      const run = { deadline: started + budgetMs, done: new Set(done), left: 0 };
      const made = [];
      kinds = await Promise.all(
        kinds.map(async (kind) => {
          try {
            const out = await discoverKind(toolkit, kind, account, onProgress, known, run);
            made.push(...out.made);
            cost += out.cost;
            return out.kind;
          } catch (e) {
            onProgress({ kind: kind.name, error: e.message });
            return kind;
          }
        }),
      );
      return { kinds, made, cost, left: run.left };
    },

    // Everyday reads of an app without ready recipes, planned by a model from the app's read tools in one call:
    // [{ name, about, tool, args, tags }], fixed calls over the person's own data that need no id, each named by its
    // result ("Open issues assigned to me"). Run once, each becomes a recipe with its result; any can be live-synced.
    // The plan is about the app, not the person: cached for a day.
    async intents({ toolkit }) {
      const hit = intentPlans.get(toolkit);
      if (hit && Date.now() - hit.at < 86_400_000) return hit.plan;
      const plan = (async () => {
        const tools = await genter.app_tools({ toolkit });
        if (!tools.length) return { intents: [], cost: 0 };
        const { json, cost } = await ask(
          `These are the read tools of ${toolkit}, called as the connected person. Plan up to 8 calls they would want ready ` +
            "to see their own data, each with a different intent: what is new or recent, what is assigned to or waits for them, " +
            "what is unread or open, what is coming up, the lists of their projects, channels, boards or files. " +
            "Each call runs as it is, with fixed args: never an id, a name or an email you do not know, never a global or public " +
            "search. Ask for 20-50 items. Dates are placeholders filled when it runs: {{now}}, {{today}}, {{tomorrow}}, " +
            "{{ago.7d}}, {{ahead.7d}} (any number of days). name says what the result is, up to 8 words, e.g. \"Open issues assigned to me\"; " +
            "about says in one sentence what each item has. tags: 3-5 words in English and Russian.\n" +
            'Reply with JSON only: {"intents": [{"name": "...", "about": "...", "tool": "...", "args": {...}, "tags": ["..."]}]}\n\n' +
            JSON.stringify(tools),
        );
        const known = new Set(tools.map((t) => t.tool));
        const intents = (json.intents ?? [])
          .filter((x) => x?.name && known.has(x.tool) && x.args && typeof x.args === "object" && !Array.isArray(x.args))
          .slice(0, 8)
          .map((x) => ({ name: String(x.name).slice(0, 100), about: String(x.about ?? "").slice(0, 400), tool: x.tool, args: x.args, tags: (x.tags ?? []).map(String).slice(0, 6) }));
        return { intents, cost };
      })();
      intentPlans.set(toolkit, { at: Date.now(), plan });
      plan.catch(() => intentPlans.delete(toolkit));
      return plan;
    },

    // goal: what to sync in the user's words; toolkit, account: optional hints.
    // Returns { saved: true, id, scope, recipe, test } or { saved: false, answer }.
    async build({ goal, toolkit, account }) {
      const ctx = { account, saved: null };
      const messages = [{ role: "user", content: `Build a live sync recipe for: ${goal}${toolkit ? `\nApp: ${toolkit}` : ""}` }];
      let cost = 0;
      let steps = 0;
      for (let step = 0; step < maxSteps && !ctx.saved; step++) {
        const { message, cost: c } = await llm(messages);
        cost += c;
        steps++;
        messages.push({ role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length && { tool_calls: message.tool_calls }) });
        if (!message.tool_calls?.length) return { saved: false, answer: message.content ?? "Could not build a recipe.", cost, steps };
        for (const tc of message.tool_calls) {
          let input = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {}
          onEvent({ type: "step", tool: `builder:${tc.function.name}`, input: tc.function.name === "try_tool" ? { tool: input.tool } : {} });
          const out = await call(tc.function.name, input, ctx).catch((e) => ({ error: e.message }));
          const text = JSON.stringify(out);
          messages.push({ role: "tool", tool_call_id: tc.id, content: text.length > 12000 ? `${text.slice(0, 12000)}… (truncated)` : text });
        }
      }
      return ctx.saved ? { saved: true, ...ctx.saved, cost, steps } : { saved: false, answer: `No working recipe after ${maxSteps} steps.`, cost, steps };
    },
  };
}

const SYSTEM = `You build live sync recipes: JSON that tells a generic sync engine how to keep an app's content as searchable knowledge.
The engine lists every item (page by page), reads only items whose version changed, drops items that are gone, and runs on every trigger event.

Recipe format:
{
  "name": "...", "toolkit": "<composio app slug>", "description": "what it syncs",
  "title": "display title of a source, may use {{field}}",
  "scope": { "<field>": { "description": "...", "required": true?, "example": "..." } },   // what the user picks: repo, project, label...
  "choices"?: { "tool", "args", "items", "label", "hint"?, "updated"?, "scope": { "<field>": "<path in a choice item>" }, "next"? | "nextPage"?: true, "pages"? },
  "setup"?: [ { "tool", "args", "set": { "<field>": "<path>" } } ],   // fills scope fields left empty, e.g. a default branch
  "list": { "tool", "args", "items": "<path to the array>", "id", "version", "title", "url"?, "text"?, "next"?: "<path to the next cursor>", "where"?, "skip"?, "parent"? },
  "read"?: { "tool", "args", "text": "<path>", "encoding"?: "<path to 'base64' marker>" },   // omit when list.text has the full text
  "triggers"?: [ { "slug", "config": { ... }, "label": "on every ...", "fallback"?: { ... } } ],
  "exclude"?: [ "<regex on item id>" ], "maxSize"?: <bytes, with list.size>
}
Paths are dotted from the tool's result: "data.issues", "data.items.0.title", "properties.*.title.0.plain_text" (* = first key that matches).
args may use {{field}} (scope), {{item.id}} / {{item.<path>}} (read), {{page}} (the cursor from list.next, or the page number with nextPage).
A placeholder that is the whole value keeps its type; an empty one drops the argument (so the first page has no cursor).
where/skip: { "<path>": value } — keep only items where every path equals its value / drop items where any does; "*" = the path is there.

How to work:
1. Find the tool that lists the items (search_tools, get_tool_schema). Prefer one that returns an updated time, sha or etag per item: that is the version.
   List every state (open and closed, archived when relevant) unless the goal says otherwise; ask for the largest page size.
2. try_tool it with real args from the goal and read the real response to get the exact paths. Never guess a path you have not seen.
3. If items in the list lack the full text, find a read tool and try_tool it on one item.
4. Write the recipe and test_live_sync it with a real scope. Fix every problem it reports, using its raw output, until ok is true.
5. Always call list_triggers for the app. Add the triggers whose events fire when an item of THIS kind is created or changed
   (for pull requests: a pull request event, not an issue one), config from scope placeholders. Several are fine.
   Do not add triggers whose required config you can not fill from the scope (e.g. a single item's id). None fits: leave triggers out.
6. save_live_sync with a plain description, a short one-liner, tags in English and Russian, and the scope you tested with.
Keep the recipe generic (scope fields, no hardcoded repo or project) so it works for any target of the same kind.

Examples (built in):
${JSON.stringify({ github: BUILTIN.github, notion: BUILTIN.notion })}`;

const TOOLS = [
  { name: "search_tools", description: "Search Composio tools by what they do.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_tool_schema", description: "Argument schemas of up to 5 tools.", parameters: { type: "object", properties: { tools: { type: "array", items: { type: "string" } } }, required: ["tools"] } },
  {
    name: "try_tool",
    description: "Run a tool with args and see its real (clipped) response, to learn the paths. Use only tools that read.",
    parameters: { type: "object", properties: { tool: { type: "string" }, args: { type: "object", additionalProperties: true } }, required: ["tool"] },
  },
  { name: "list_triggers", description: "Composio triggers of an app: slug, config fields, payload.", parameters: { type: "object", properties: { toolkit: { type: "string" } }, required: ["toolkit"] } },
  {
    name: "test_live_sync",
    description: "Test a recipe on real data without saving: first page, two items read, problems, raw items.",
    parameters: {
      type: "object",
      properties: { recipe: { type: "object", additionalProperties: true }, scope: { type: "object", additionalProperties: true } },
      required: ["recipe", "scope"],
    },
  },
  {
    name: "save_live_sync",
    description: "Save the recipe (it is tested again). Ends the build.",
    parameters: {
      type: "object",
      properties: {
        recipe: { type: "object", additionalProperties: true },
        description: { type: "string" },
        short: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        scope: { type: "object", additionalProperties: true },
      },
      required: ["recipe", "description", "scope"],
    },
  },
].map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));

// Only the {{container...}} placeholders of a template, so {{item...}} and {{page}} stay for the sync engine.
function fillContainer(value, ctx) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{(container(?:\.[\w.*]+)?)\}\}$/);
    if (whole) return pick(ctx, whole[1]) ?? value;
    return value.replace(/\{\{(container(?:\.[\w.*]+)?)\}\}/g, (m, p) => {
      const v = pick(ctx, p);
      return v == null ? m : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillContainer(v, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillContainer(v, ctx)]));
  return value;
}

const clip = (v, max = 3000) => JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 200 ? `${x.slice(0, 200)}…` : Array.isArray(x) && x.length > 3 ? x.slice(0, 3) : x)).slice(0, max);

// Runs fn over items, n at a time.
// Ready plans for popular apps: no model call, the same kinds every time. Others are planned by the model.
const repos = { tool: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", args: { sort: "updated", direction: "desc", per_page: 100 } };
const PLANS = {
  "github": [
    {
      "name": "Repository files",
      "description": "All files in each repository owned by the connected user, recursively, on its default branch. Keep every page so the repository tree stays complete.",
      "recommended": true,
      "containers": repos,
      "items": {
        "tool": "GITHUB_GET_A_TREE",
        "args": {
          "owner": "{{container.owner.login}}",
          "repo": "{{container.name}}",
          "tree_sha": "{{container.default_branch}}",
          "recursive": true
        },
        "where": {
          "type": "blob"
        }
      },
      "read": {
        "tool": "GITHUB_GET_RAW_REPOSITORY_CONTENT",
        "args": {
          "owner": "{{container.owner.login}}",
          "repo": "{{container.name}}",
          "ref": "{{container.default_branch}}",
          "path": "{{item.path}}"
        }
      }
    },
    {
      "name": "Issues",
      "description": "All issues in each owned repository, including open and closed issues, but excluding pull requests. Retrieve every page.",
      "recommended": true,
      "containers": repos,
      "items": {
        "tool": "GITHUB_LIST_REPOSITORY_ISSUES",
        "args": {
          "owner": "{{container.owner.login}}",
          "repo": "{{container.name}}",
          "state": "all",
          "per_page": 100,
          "page": "{{page}}"
        },
        "skip": {
          "pull_request": "*"
        }
      }
    },
    {
      "name": "Pull requests",
      "description": "All pull requests in each owned repository, open and closed, with every page included.",
      "recommended": true,
      "containers": repos,
      "items": {
        "tool": "GITHUB_GET_PULL_REQUESTS",
        "args": {
          "owner": "{{container.owner.login}}",
          "repo": "{{container.name}}",
          "state": "all",
          "per_page": 100,
          "page": "{{page}}"
        }
      }
    },
    {
      "name": "Releases",
      "description": "Published, draft, and prerelease records for each owned repository, retrieved across all pages.",
      "recommended": false,
      "containers": repos,
      "items": {
        "tool": "GITHUB_LIST_RELEASES",
        "args": {
          "owner": "{{container.owner.login}}",
          "repo": "{{container.name}}",
          "per_page": 100,
          "page": "{{page}}"
        }
      }
    }
  ],
  "googletasks": [
    {
      "name": "Tasks",
      "description": "Tasks from each of your Google Tasks lists, including completed, hidden, deleted, and assigned tasks where available. Each task list is kept up to date separately.",
      "recommended": true,
      "containers": {
        "tool": "GOOGLETASKS_LIST_TASK_LISTS",
        "args": {
          "maxResults": 100
        }
      },
      "items": {
        "tool": "GOOGLETASKS_LIST_TASKS",
        "args": {
          "tasklist_id": "{{container.id}}",
          "maxResults": 100,
          "pageToken": "{{page}}",
          "showCompleted": true,
          "showHidden": true,
          "showDeleted": true,
          "showAssigned": true
        }
      },
      "read": {
        "tool": "GOOGLETASKS_GET_TASK",
        "args": {
          "tasklist_id": "{{container.id}}",
          "task_id": "{{item.id}}"
        }
      }
    }
  ],
  "gmail": [
    {
      "name": "Recent email threads",
      "description": "Recent Gmail conversations, including message content, for searchable personal correspondence. Limited to the past year and refreshed with pagination.",
      "recommended": true,
      "items": {
        "tool": "GMAIL_LIST_THREADS",
        "args": {
          "user_id": "me",
          "query": "newer_than:1y",
          "verbose": true,
          "max_results": 500,
          "page_token": "{{page}}"
        }
      }
    },
    {
      "name": "Contacts",
      "description": "The account’s saved contacts, including names, email addresses, organizations, and other available contact details.",
      "recommended": true,
      "items": {
        "tool": "GMAIL_GET_CONTACTS",
        "args": {
          "person_fields": "names,emailAddresses,organizations,phoneNumbers,addresses,biographies",
          "page_token": "{{page}}",
          "include_other_contacts": false
        }
      }
    }
  ]
};

// A step that takes too long (an app call or a model that hangs) fails instead of holding up the whole round.
const STEP_MS = 90_000;
function within(ms, fn) {
  let timer;
  return Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`took over ${ms / 1000}s`)), ms)))]).finally(() => clearTimeout(timer));
}

const plans = new Map(); // toolkit -> { at, plan: Promise<{ kinds, cost }> }
const intentPlans = new Map(); // toolkit -> { at, plan: Promise<{ intents, cost }> }

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
