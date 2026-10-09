import { readFileSync } from "node:fs";

// Tool catalogues of real Composio apps (slugs, params and required lists as Composio returns them) and a sample
// response of each app's main list call: the "not GitHub" scenarios run on them.
export const catalogues = JSON.parse(readFileSync(new URL("./fixtures/catalogues.json", import.meta.url), "utf8"));

// An OpenRouter stand-in: each chat call takes the next scripted reply. A reply is an assistant message, or a function
// of the request body that returns one. Every request body is kept in `requests`.
export function fakeModel(script) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("openrouter.ai")) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    const next = script.shift();
    if (!next) throw new Error("the model was called more times than scripted");
    const message = typeof next === "function" ? next(body) : next;
    return { ok: true, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } }) };
  };
  return { requests, restore: () => (globalThis.fetch = original) };
}

// An assistant message that calls tools: call("execute", {...}), several at once with calls([...]).
let ids = 0;
export const call = (name, args) => ({ content: null, tool_calls: [{ id: `c${++ids}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
export const answer = (content) => ({ content });

// The text of the last user/tool message of a request, and the first user message (the briefing).
export const briefingOf = (body) => body.messages.find((m) => m.role === "user").content;
export const lastOf = (body, role) => [...body.messages].reverse().find((m) => m.role === role)?.content;

// A genter stand-in for the agent: anchors, tool results and catalogues given per test.
// execute(tool, args) answers from `results` (a value or a function of args); every call is kept in `executed`.
export function fakeGenter({ connected = [], recipes = [], results = {}, catalogs = {} } = {}) {
  const executed = [];
  const rechecked = [];
  const gone = [];
  const asked = [];
  return {
    executed,
    rechecked,
    gone,
    asked,
    recipes: {
      asked: async ({ ids, task }) => (asked.push({ ids, task }), { filed: ids.length }),
      recheck: async (id) => (rechecked.push(id), { recipe: { id, title: "t" }, changed: id.endsWith("changed"), status: "fresh" }),
      markGone: async (id) => (gone.push(id), { id, status: "gone" }),
    },
    login: async () => ({ connected: connected.map((toolkit) => ({ toolkit, account: `ca_${toolkit}`, status: "ACTIVE" })) }),
    search: async () => recipes,
    schema: async (tool) => ({ tool, args: {} }),
    catalog: async ({ toolkit }) => catalogs[toolkit] ?? [],
    async execute({ id, tool, args = {}, account, remember, plain }) {
      // An anchor run by its id runs the call it was made by (rcp_<n>: the n-th call of the test).
      if (id && !tool && /^rcp_\d+$/.test(id)) ({ tool, args } = { ...executed[Number(id.slice(4)) - 1], args: { ...executed[Number(id.slice(4)) - 1]?.args, ...args } });
      executed.push({ id, tool, args, account, ...(remember === false && { remember }), ...(plain && { plain }) });
      const out = results[tool];
      if (out === undefined) return { result: { successful: false, error: `no fake result for ${tool}` } };
      const data = typeof out === "function" ? out(args) : out;
      return { id: `rcp_${executed.length}`, result: { successful: true, data }, created: true, changed: false, unchanged: false, summary: null };
    },
  };
}

// Runs kept in memory, like the backend's table.
export function memoryRuns() {
  const rows = new Map();
  return { get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), rows };
}
