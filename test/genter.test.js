import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createGenter } from "../src/genter.js";

// The real createGenter on a Composio stand-in: tool calls are answered over fetch, so execute runs its own code
// (the agent tests replace genter as a whole and never reach it).
let restore;
afterEach(() => restore?.());

// model (optional): OpenRouter too. chat(prompt) -> the reply's JSON; vector(text) -> an embedding.
function fakeComposio(data, model) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (model && u.includes("openrouter.ai/api/v1/embeddings")) {
      const input = [JSON.parse(init.body).input].flat();
      return json({ data: input.map((t, index) => ({ index, embedding: model.vector(t) })) });
    }
    if (model && u.includes("openrouter.ai/api/v1/chat")) {
      const prompt = JSON.parse(init.body).messages.at(-1).content;
      const reply = model.chat(prompt);
      if (reply === null) return new Response("provider error", { status: 502 }); // the model failed
      return json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    }
    if (u.includes("/tools/execute/")) return json({ data, successful: true, error: null, log_id: "l1" });
    if (u.includes("/tools/")) return json({ slug: u.split("/").pop().split("?")[0], name: "Tool", description: "", toolkit: { slug: "github", name: "GitHub", logo: "" }, input_parameters: {}, output_parameters: {}, tags: [], version: "1", available_versions: ["1"], scopes: [], no_auth: false, is_deprecated: false, deprecated: { displayName: "", version: "1", available_versions: ["1"], is_deprecated: false, toolkit: { logo: "" } } });
    return json({ items: [] });
  };
  restore = () => (globalThis.fetch = original);
  return calls;
}

const memoryStore = () => {
  const rows = new Map();
  return { rows, get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), all: async () => [...rows.values()] };
};

describe("genter.execute", () => {
  it("G1 a call that is saved as a recipe returns its result and an id (remember is not shadowed)", async () => {
    const calls = fakeComposio({ commits: [{ sha: "c1", commit: { message: "m" } }] });
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } });
    assert.equal(out.result.successful, true);
    assert.deepEqual(out.result.data, { commits: [{ sha: "c1", commit: { message: "m" } }] });
    assert.ok(out.id);
    assert.ok(store.rows.has(out.id));
    assert.ok(calls.some((u) => u.includes("/tools/execute/GITHUB_LIST_COMMITS")));
    await Promise.all(deferred);
  });

  it("G2 remember: false runs it without saving it", async () => {
    fakeComposio({ content: { content: "YQ==", encoding: "base64" } });
    const store = memoryStore();
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: () => {} });
    const out = await genter.execute({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path: "a" }, remember: false });
    assert.equal(out.result.successful, true);
    assert.equal(out.id, undefined);
    assert.equal(store.rows.size, 0);
  });

  // "когда мне убираться" went to Gmail: ("уборка" OR "clean up") found only a GitHub notification, and it was saved
  // as a recipe "Emails about cleaning" with that notification as its result.
  it("G3 a result with nothing for the request it was made for is not kept as a recipe", async () => {
    fakeComposio(
      { messages: [{ subject: "Fix the recipe page (PR #39)", from: "notifications@github.com" }] },
      {
        chat: (prompt) => {
          assert.match(prompt, /когда мне убираться/); // the request goes to the model that names the result
          return { title: "Emails about cleaning", summary: "A GitHub notification that PR #39 was merged.", items: ['Email "Fix the recipe page (PR #39)"'], relevant: false };
        },
        vector: (t) => (t === "когда мне убираться" ? [1, 0, 0] : [0, 1, 0]), // nothing in it is close to the request
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GMAIL_FETCH_EMAILS", args: { query: '("уборка" OR "clean up")' }, description: "### Emails about cleaning", task: "когда мне убираться" });
    await Promise.all(deferred);
    assert.equal(out.result.successful, true);
    const row = store.rows.get(out.id);
    assert.equal(row.remembered, false); // search never offers it
    assert.ok(!(await genter.search({ query: "emails about cleaning" })).some((r) => r.id === out.id));
    assert.equal((await genter.execute({ id: out.id, remember: false })).result.successful, true); // its id still runs
  });

  // "Уборка" was one of ten events in the summary of "Events of the past 7 days": as one vector it scored 0.20 against
  // the request, under the 0.25 a recipe needs, and the agent searched mail, tasks and calendars for 44 s instead.
  it("G4 one thing among many in a result finds its recipe by its own line, and says so", async () => {
    const cleaning = (t) => /убир|уборк|clean/i.test(t);
    fakeComposio(
      { items: [{ summary: "Оплатить подписки" }, { summary: "Уборка" }] },
      {
        chat: (prompt) =>
          /Translate it for searching/.test(prompt)
            ? { en: "when do I need to clean", terms: ["уборка", "cleaning"] }
            : { title: "Events of the past 7 days", summary: "Ten events: payments, LinkedIn, a demo.", items: ['Calendar event "Оплатить подписки"', 'Calendar event "Уборка" on 2026-10-03 13:00'], relevant: true },
        // Only the item line is about cleaning: the summary and the description are not.
        vector: (t) => (t.startsWith("когда") || t === 'Calendar event "Уборка" on 2026-10-03 13:00' ? [1, 0, 0] : [0, 1, 0]),
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GOOGLECALENDAR_EVENTS_LIST", args: { calendarId: "primary" }, task: "events of the past week" });
    await Promise.all(deferred);
    assert.equal(cleaning("Ten events: payments, LinkedIn, a demo."), false);
    const found = await genter.search({ query: "когда мне убираться надо" });
    const recipe = found.find((r) => r.id === out.id);
    assert.ok(recipe, "the calendar recipe is offered");
    assert.ok(recipe.score >= 0.45); // known ground: the fast model answers from it
    assert.deepEqual(recipe.matched, ['Calendar event "Уборка" on 2026-10-03 13:00']);
  });

  it("G5 a key term of the request written in a recipe's result puts it among the recipes, items or not", async () => {
    fakeComposio(
      { items: [{ summary: "Уборка" }] },
      {
        chat: (prompt) =>
          /Translate it for searching/.test(prompt)
            ? { en: "when is the cleaning", terms: ["уборка", "cleaning"] }
            : { title: "Events of the past 7 days", summary: 'Ten events, among them "Уборка".', relevant: true },
        vector: (t) => (t.startsWith("когда") ? [1, 0, 0] : [0, 1, 0]), // nothing is close by meaning
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GOOGLECALENDAR_EVENTS_LIST", args: { calendarId: "primary" } });
    await Promise.all(deferred);
    const recipe = (await genter.search({ query: "когда уборка" })).find((r) => r.id === out.id);
    assert.ok(recipe, "found by the word in its result");
    assert.ok(recipe.score >= 0.25 && recipe.score < 0.45); // offered, but not so sure that tools are skipped
  });

  // "List all upcoming calendar events" was saved with "No result summary yet": a recipe whose result is unknown
  // is found by nothing and answers nothing.
  it("G6 a call whose result could not be summarized is not kept as a recipe, nor made one by save_recipes", async () => {
    const chats = [];
    fakeComposio({ items: [{ summary: "Уборка" }] }, { chat: (prompt) => (chats.push(prompt), null), vector: () => [0, 1, 0] });
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GOOGLECALENDAR_EVENTS_LIST", args: { calendarId: "primary" }, description: "### Upcoming events", task: "когда уборка" });
    const [saved] = await genter.save_recipes({ recipes: [{ id: out.id, description: "### Upcoming events" }] }); // the agent, before the summary
    await Promise.all(deferred);
    assert.equal(chats.length, 2); // tried twice
    assert.equal(saved.status, "not saved: no result summary");
    assert.equal(store.rows.get(out.id).remembered, false);
  });

  // gpt-oss-120b once called 40 events with «Уборка» unrelated to "когда мне убираться": the recipe would be lost.
  it("G7 a result the model calls unrelated is kept when one of its lines is close to the request", async () => {
    fakeComposio(
      { items: [{ id: "e1", summary: "Йога" }, { id: "e2", summary: "Уборка" }] },
      {
        chat: () => ({ title: "Events", summary: "Yoga and other events.", items: [], relevant: false }),
        vector: (t) => (t === "когда мне убираться" || t.startsWith("Уборка") ? [1, 0, 0] : [0, 1, 0]),
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GOOGLECALENDAR_EVENTS_LIST", args: { calendarId: "primary" }, task: "когда мне убираться" });
    await Promise.all(deferred);
    assert.equal(store.rows.get(out.id).remembered, true);
  });
});
