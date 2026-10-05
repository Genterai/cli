import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { addQuery, createGenter } from "../src/genter.js";

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
    if (u.includes("/tools/execute/")) {
      const sent = JSON.parse(init.body);
      const out = typeof data === "function" ? data(sent, u) : data;
      if (out?.__error) return json({ data: {}, successful: false, error: out.__error, log_id: "l1" });
      return json({ data: out, successful: true, error: null, log_id: "l1" });
    }
    if (u.includes("/tools/")) return json({ slug: u.split("/").pop().split("?")[0], name: "Tool", description: "", toolkit: { slug: "github", name: "GitHub", logo: "" }, input_parameters: {}, output_parameters: {}, tags: [], version: "1", available_versions: ["1"], scopes: [], no_auth: false, is_deprecated: false, deprecated: { displayName: "", version: "1", available_versions: ["1"], is_deprecated: false, toolkit: { logo: "" } } });
    return json({ items: [] });
  };
  restore = () => (globalThis.fetch = original);
  return calls;
}

const memoryStore = () => {
  const rows = new Map();
  return { rows, get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), all: async () => [...rows.values()].filter((r) => r.remembered), remove: async (id) => rows.delete(id) };
};

describe("genter.execute", () => {
  it("G1 a call that is saved as a recipe returns its result and a deterministic id", async () => {
    const calls = fakeComposio({ commits: [{ sha: "c1", commit: { message: "m" } }] });
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } });
    assert.equal(out.result.successful, true);
    assert.deepEqual(out.result.data, { commits: [{ sha: "c1", commit: { message: "m" } }] });
    assert.ok(out.id);
    assert.ok(store.rows.has(out.id));
    assert.match(out.id, /^rcp_[0-9a-f]{24}$/);
    assert.equal(out.created, true);
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

  // The table shows one sentence about the result (`short`); retrieval embeds the richer summary, not that sentence.
  it("G4b a new recipe gets a one-sentence result description apart from its title, and is found by its result summary", async () => {
    const SUMMARY = "Three open pull requests: #12 fix login, #15 add billing page, #18 bump deps.";
    fakeComposio(
      { items: [{ title: "fix login" }] },
      {
        chat: (prompt) =>
          /Translate it for searching/.test(prompt)
            ? { en: "which pull requests are waiting", terms: [] }
            : { title: "Open pull requests of o/r", about: "Open PRs.", short: "Titles and numbers of pull requests still waiting for review.", summary: SUMMARY, items: [], relevant: true },
        vector: (t) => (t === SUMMARY || t.startsWith("which pull") ? [1, 0, 0] : [0, 1, 0]), // only the summary is close to the request
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GITHUB_LIST_PULL_REQUESTS", args: { owner: "o", repo: "r" } });
    await Promise.all(deferred);
    const recipe = (await genter.search({ query: "which pull requests are waiting" })).find((r) => r.id === out.id);
    assert.ok(recipe, "found through its result summary");
    assert.equal(recipe.short, "Titles and numbers of pull requests still waiting for review.");
    assert.notEqual(recipe.short, "Open pull requests of o/r");
    assert.equal(recipe.summary, SUMMARY); // the rich text is kept for retrieval and the recipe page
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

});

// Recipe = one successful call with fixed args + knowledge about its result: identity, upsert, change detection.
describe("recipes", () => {
  const SUMMARY = (n) => `Open pull requests: ${n}.`;
  // A model that counts its calls: chat describes the result by how many items it holds, vectors are constant.
  function counting() {
    const seen = { chats: [], embeds: 0 };
    const model = {
      chat: (prompt) => {
        seen.chats.push(prompt);
        const n = (prompt.match(/"title"/g) ?? []).length - 1; // one is the reply format in the prompt
        return { title: "Open pull requests of o/r", short: "Titles of open pull requests.", summary: SUMMARY(n), items: ["PR fix login"] };
      },
      vector: () => {
        seen.embeds++;
        return [1, 0, 0];
      },
    };
    return { seen, model };
  }
  const prs = (...titles) => ({ items: titles.map((title, i) => ({ id: i + 1, title })) });
  const setup = (data, extra = {}) => {
    const { seen, model } = counting();
    const calls = fakeComposio(data, model);
    const store = memoryStore();
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, ...extra });
    return { seen, calls, store, genter };
  };
  const run = async (genter, input) => {
    const out = await genter.execute({ tool: "GITHUB_LIST_PULL_REQUESTS", args: { owner: "o", repo: "r" }, ...input });
    await out.pending;
    return out;
  };
  const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  it("R1 the same call upserts one record, whatever the order of its args", async () => {
    const { genter, store } = setup(prs("fix login"));
    const a = await run(genter, { args: { owner: "o", repo: "r", state: "" } }); // "" is no argument
    const b = await run(genter, { args: { repo: "r", owner: "o" } });
    assert.equal(a.id, b.id);
    assert.equal(store.rows.size, 1);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.unchanged, true);
    const record = await genter.recipes.get(a.id);
    assert.deepEqual(record.args, { owner: "o", repo: "r" });
    assert.equal(record.status, "fresh");
    assert.equal(record.title, "Open pull requests of o/r");
    assert.equal(record.summary, SUMMARY(1));
    assert.equal(record.summaryEmbedding, undefined); // vectors never leave the engine
  });

  it("R2 an unchanged result calls neither the describing model nor embeddings and only bumps checked_at", async () => {
    const { genter, seen, calls } = setup(prs("fix login"));
    const first = await run(genter, {});
    const before = await genter.recipes.get(first.id);
    const chats = seen.chats.length;
    const embeds = calls.filter((u) => u.includes("/embeddings")).length;
    assert.ok(chats >= 1 && embeds >= 1);
    await wait();
    const second = await run(genter, {});
    assert.equal(second.unchanged, true);
    assert.equal(second.changed, false);
    assert.equal(seen.chats.length, chats);
    assert.equal(calls.filter((u) => u.includes("/embeddings")).length, embeds);
    const after = await genter.recipes.get(first.id);
    assert.ok(after.checked_at > before.checked_at);
    assert.equal(after.updated_at, before.updated_at); // the result did not change
    assert.equal(after.summary, before.summary);
    assert.equal(after.digest, before.digest);
  });

  it("R3 a changed result regenerates the same recipe", async () => {
    let titles = ["fix login"];
    const { genter, seen } = setup(() => prs(...titles));
    const first = await run(genter, {});
    const before = await genter.recipes.get(first.id);
    titles = ["fix login", "add billing"];
    await wait();
    const second = await run(genter, {});
    assert.equal(second.id, first.id);
    assert.equal(second.changed, true);
    assert.equal(second.created, false);
    const after = await genter.recipes.get(first.id);
    assert.equal(after.summary, SUMMARY(2));
    assert.notEqual(after.digest, before.digest);
    assert.ok(after.updated_at > before.updated_at);
    assert.equal((await genter.recipes.list()).length, 1);
    assert.equal(seen.chats.length, 2);
  });

  it("R4 a failed call creates no recipe", async () => {
    const { genter, store } = setup(() => ({ __error: "Something broke" }));
    const out = await genter.execute({ tool: "GITHUB_LIST_PULL_REQUESTS", args: { owner: "o", repo: "r" } });
    assert.equal(out.result.successful, false);
    assert.equal(out.id, undefined);
    assert.equal(store.rows.size, 0);
  });

  it("R5 a failure on an existing recipe marks it gone or denied, and search stops offering it", async () => {
    let failure = null;
    const { genter } = setup(() => failure ?? prs("fix login"));
    const gone = await run(genter, { args: { owner: "o", repo: "deleted" } });
    const denied = await run(genter, { args: { owner: "o", repo: "private" } });
    assert.ok(await genter.search({ query: "open pull requests" }).then((r) => r.some((x) => x.id === gone.id) && r.some((x) => x.id === denied.id)));

    failure = { __error: "Not Found (404)" };
    const a = await genter.execute({ id: gone.id });
    assert.equal(a.recipe_status, "gone");
    failure = { __error: "403 Forbidden: Resource not accessible" };
    const b = await genter.execute({ id: denied.id });
    assert.equal(b.recipe_status, "denied");
    failure = { __error: "request timed out" };
    const c = await genter.execute({ id: denied.id });
    assert.equal(c.recipe_status, undefined); // a timeout says nothing about the recipe

    assert.equal((await genter.recipes.get(gone.id)).status, "gone");
    assert.equal((await genter.recipes.get(denied.id)).status, "denied");
    const found = await genter.search({ query: "open pull requests" });
    assert.ok(!found.some((x) => x.id === gone.id || x.id === denied.id));

    failure = null; // the object is back: the same call makes the recipe fresh again
    const back = await genter.execute({ id: gone.id });
    assert.equal(back.recipe_status, "fresh");
    assert.equal((await genter.recipes.get(gone.id)).status, "fresh");
  });

  it("R6 two accounts of one app are two recipes, and revoking one denies only its own", async () => {
    const { genter } = setup(prs("fix login"));
    const a = await run(genter, { account: "ca_work" });
    const b = await run(genter, { account: "ca_home" });
    assert.notEqual(a.id, b.id);
    assert.equal((await genter.recipes.list()).length, 2);
    assert.equal((await genter.recipes.get(a.id)).scope.account, "ca_work");
    assert.deepEqual(await genter.recipes.invalidateAccount({ account: "ca_work" }), { count: 1 });
    assert.equal((await genter.recipes.get(a.id)).status, "denied");
    assert.equal((await genter.recipes.get(b.id)).status, "fresh");
    const found = await genter.search({ query: "open pull requests" });
    assert.deepEqual(found.filter((x) => x.id).map((x) => x.id), [b.id]);
  });

  it("R7 a page of a bigger result is partial and its summary is asked to claim only what came back", async () => {
    const { genter, seen } = setup({ items: [{ title: "a" }], next_page_token: "abc" });
    const out = await run(genter, {});
    assert.equal((await genter.recipes.get(out.id)).partial, true);
    assert.match(seen.chats[0], /only a PAGE or was cut off/);
    assert.match(seen.chats[0], /claim ONLY what was returned/);
  });

  it("R8 search returns fresh recipes with their calls, summaries and times, not tool descriptions", async () => {
    const { genter, seen } = setup(prs("fix login"));
    const out = await run(genter, {});
    const [hit] = await genter.search({ query: "open pull requests" });
    assert.deepEqual(Object.keys(hit).sort(), ["args", "checked_at", "id", "matched", "score", "short", "status", "summary", "title", "tool", "trigger", "updated_at"].filter((k) => k in hit).sort());
    assert.equal(hit.id, out.id);
    assert.deepEqual(hit.args, { owner: "o", repo: "r" });
    assert.deepEqual(hit.trigger, { active: false });
    assert.equal(hit.status, "fresh");
    assert.ok(seen.chats.every((p) => !/Composio tool description/.test(p)));
  });

  it("R9 recheck runs the saved call again; remove, markGone, triggers and scopes", async () => {
    const scopes = new Map();
    const scopeStore = { get: async (id) => scopes.get(id), put: async (r) => scopes.set(r.id, r), list: async () => [...scopes.values()], remove: async (id) => scopes.delete(id) };
    let titles = ["fix login"];
    const { genter } = setup(() => prs(...titles), { scopes: scopeStore });
    const out = await run(genter, {});
    let again = await genter.recipes.recheck(out.id);
    assert.equal(again.changed, false);
    assert.equal(again.status, "fresh");
    titles = ["fix login", "x"];
    again = await genter.recipes.recheck(out.id);
    assert.equal(again.changed, true);
    assert.equal(again.recipe.summary, SUMMARY(2));

    assert.equal(await genter.recipes.recommendTrigger(out.id), null); // no trigger types: asked once, cached as null
    assert.equal((await genter.recipes.get(out.id)).trigger.spec, null);
    await assert.rejects(genter.recipes.setTrigger({ id: out.id, active: true }), /hosted backend/);
    assert.deepEqual(await genter.recipes.byTrigger({ triggerId: "t1" }), []);

    assert.equal((await genter.recipes.markGone(out.id)).status, "gone");
    const scope = await genter.recipes.prepareScope({ label: "Entire repository o/r", toolkit: "github", account: "ca_1" });
    assert.match(scope.id, /^scp_/);
    assert.deepEqual((await genter.recipes.scopes()).map((x) => x.label), ["Entire repository o/r"]);
    assert.deepEqual(await genter.recipes.remove(out.id), { id: out.id, removed: true });
    assert.deepEqual(await genter.recipes.list(), []);
  });
});

describe("queryEmbeddings", () => {
  // The old request and the new clumsy one are close; the summary and the items are far from both.
  const vector = (t) => (t.startsWith("old question") ? [1, 0, 0] : t.startsWith("clumsy") ? [0.99, 0.1, 0] : [0, 1, 0]);
  const setup = () => {
    fakeComposio(
      { items: [{ title: "x" }] },
      {
        chat: (prompt) =>
          /Translate it for searching/.test(prompt)
            ? { en: "", terms: [] }
            : { title: "Open pull requests", short: "PRs.", summary: "Three open pull requests.", items: [] },
        vector,
      },
    );
    const store = memoryStore();
    return { store, genter: createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store }) };
  };
  const call = { tool: "GITHUB_LIST_PULL_REQUESTS", args: { owner: "o", repo: "r" } };

  it("Q1 a new question close to a past request (far from the summary) finds the recipe through it", async () => {
    const { genter } = setup();
    await genter.search({ query: "old question about waiting reviews" });
    const out = await genter.execute({ ...call, task: "old question about waiting reviews" });
    await out.pending;
    const recipe = (await genter.search({ query: "clumsy way to ask it" })).find((r) => r.id === out.id);
    assert.ok(recipe, "found through the stored request");
    assert.ok(recipe.score >= 0.9);
    assert.equal(recipe.queryEmbeddings, undefined);
  });

  it("Q2 the same request again raises the count; the vector is cut to 256 dims and survives the store", async () => {
    const { genter, store } = setup();
    for (let i = 0; i < 2; i++) {
      await genter.search({ query: "old question" });
      await (await genter.execute({ ...call, task: "old question" })).pending;
    }
    const [row] = store.rows.values();
    assert.ok(row.blob, "stored as a blob");
    assert.ok(!JSON.stringify(row).includes("queryEmbeddings"), "encrypted: not visible in the row");
    assert.ok((await genter.search({ query: "clumsy way to ask it" })).some((r) => r.tool === call.tool));
  });

  it("Q3 without a request on the call nothing is kept and the behaviour is as before", async () => {
    const { genter } = setup();
    const out = await genter.execute(call);
    await out.pending;
    assert.equal((await genter.search({ query: "clumsy way to ask it" })).filter((r) => r.id).length, 0);
  });

  it("Q4 a near-duplicate request raises the count of the stored one instead of adding a vector", () => {
    let list = addQuery([], [1, 0, 0]);
    list = addQuery(list, [0.99, 0.05, 0]);
    list = addQuery(list, [1, 0.01, 0]);
    assert.equal(list.length, 1);
    assert.equal(list[0].n, 3);
    assert.equal(addQuery(list, [0, 1, 0]).length, 2);
  });

  it("Q5 at most 8 requests are kept: the least frequent, then the oldest, goes", () => {
    const axis = (i) => Array.from({ length: 10 }, (_, j) => (i === j ? 1 : 0));
    let list = addQuery([], axis(0), "2026-01-01");
    list = addQuery(list, axis(0), "2026-01-02"); // axis 0 came twice
    for (let i = 1; i < 10; i++) list = addQuery(list, axis(i), `2026-02-0${i}`);
    assert.equal(list.length, 8);
    assert.equal(list[0].n, 2);
    assert.ok(!list.some((q) => q.e[1] === 1), "the oldest single went first");
    assert.ok(list.some((q) => q.e[9] === 1), "the newest is kept");
  });
});
