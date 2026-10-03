import { BUILTIN, fill, inferList, pick } from "./sync.js";

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

  // What an app can keep as knowledge, planned by a model from the app's read tools in one call:
  // [{ name, description, containers?: { tool, args }, items: { tool, args } }]; items args may use {{container}}.
  async function plan(toolkit) {
    const tools = await genter.app_tools({ toolkit });
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `These are the read tools of ${toolkit}, called as the connected person. Plan what they would want to keep as searchable ` +
              "knowledge: THEIR OWN data (their emails, events, rows, tasks, messages, posts, documents, their repos' issues...), " +
              "up to 6 kinds, most useful first. Never a global or public search (all of GitHub, all of Twitter): reach their data " +
              "through tools that list what belongs to them, or a search scoped to them (author:@me, in their workspace). " +
              "When the content lives in containers (labels, calendars, spreadsheets, task lists, channels, boards, teams, lists, " +
              "folders), give a containers call that lists them and an items call that lists the content of one, with " +
              '"{{container}}" where the container id goes: the recipe then runs over all of them. ' +
              "Prefer calls that return many items with their text and an updated time. " +
              "Use only these tools and their argument names; ask for the largest page size; recent items first.\n" +
              "Kinds must not overlap (not both all mail and inbox). Mark recommended: true on the ones most people want kept. " +
              "Streams (mail, chat, posts) take recent items only (the newest page).\n" +
              'Reply with JSON only: {"kinds": [{"name": "Emails by label", "description": "...", "recommended": true, "containers": {"tool": "...", "args": {}}, ' +
              '"items": {"tool": "...", "args": {"label_ids": ["{{container}}"], "max_results": 100}}}]} (containers is optional).\n\n' +
              JSON.stringify(tools),
          },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Planner failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { kinds: (JSON.parse(data.choices[0].message.content).kinds ?? []).slice(0, 6), cost: data.usage?.cost ?? 0 };
  }

  // A planned kind as a live sync recipe: its containers call (if any) and its items call, run for real once,
  // their lists found with inferList.
  async function shapeKind(toolkit, kind, account) {
    let each;
    let first;
    if (kind.containers?.tool) {
      const res = await genter.sources.probe({ tool: kind.containers.tool, args: kind.containers.args ?? {}, account, raw: true });
      if (res?.successful === false) throw new Error(`${kind.containers.tool}: ${JSON.stringify(res.error).slice(0, 200)}`);
      const shape = inferList(res);
      if (!shape.items) throw new Error("no containers found");
      first = [pick(res, shape.items)].flat()[0];
      each = { tool: kind.containers.tool, args: kind.containers.args ?? {}, items: shape.items, id: shape.id, label: shape.title, max: 20 };
    }
    const args = kind.items.args ?? {};
    const sampleArgs = each ? fill(args, { container: String(pick(first, each.id)) }) : args;
    const res = await genter.sources.probe({ tool: kind.items.tool, args: sampleArgs, account, raw: true });
    if (res?.successful === false) throw new Error(`${kind.items.tool}: ${JSON.stringify(res.error).slice(0, 200)}`);
    const shape = inferList(res);
    const triggers = await genter.pick_triggers({ toolkit, tool: kind.items.tool, args, description: kind.description });
    return {
      name: kind.name,
      toolkit,
      description: kind.description ?? kind.name,
      title: kind.name,
      recommended: Boolean(kind.recommended),
      scope: {},
      list: { tool: kind.items.tool, args, ...shape, ...(shape.version && shape.version === shape.id && { append: true }), ...(each && { each }) },
      triggers,
      every: triggers.length ? null : 60,
    };
  }

  return {
    // Everything an app can keep as knowledge, as recipes: plans the kinds, lists each kind's containers (up to
    // `perKind`) and runs its items call once per container. Every run is saved as a recipe with its live sync
    // plan, so each can be kept up to date with one click. onProgress gets { kind, container?, recipe?, error? }.
    // Everything an app can keep as knowledge, as live sync recipes: a model plans the kinds of the person's own data,
    // and each kind becomes one recursive recipe (its containers -> their items), shaped from real responses, with a
    // trigger or an hourly schedule, tested and saved. onProgress gets { planned } then { kind, recipe | error }.
    async discover({ toolkit, account, onProgress = () => {} }) {
      const { kinds, cost } = await plan(toolkit);
      onProgress({ planned: kinds.map((k) => ({ name: k.name, description: k.description, recommended: Boolean(k.recommended) })) });
      const made = [];
      await Promise.all(
        kinds.map(async (kind) => {
          try {
            const recipe = await shapeKind(toolkit, kind, account);
            const out = await genter.save_live_sync({ recipe, description: kind.description || kind.name, short: kind.name, tags: [toolkit, "sync", "синхронизация"], account });
            if (!out.saved) throw new Error((out.test?.problems ?? ["test failed"]).join("; "));
            made.push({ kind: kind.name, recipe: out.id });
            onProgress({ kind: kind.name, recipe: out.id });
          } catch (e) {
            onProgress({ kind: kind.name, error: e.message });
          }
        }),
      );
      return { kinds, made, cost };
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
where/skip: { "<path>": value } — keep only items where every path equals its value / drop items where any does.

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
