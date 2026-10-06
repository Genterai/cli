import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { addQuery, appsMeant, cipher, createGenter } from "../src/genter.js";

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
  it("G1 a call that is saved as an anchor returns its result and a deterministic id", async () => {
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

  it("G1a an anchor knows the area its call reads in (the repository), so a project can be offered for it", async () => {
    fakeComposio({ content: { content: "YQ==", encoding: "base64" } });
    const store = memoryStore();
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: () => {} });
    const out = await genter.execute({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path: "a" } });
    assert.deepEqual((await genter.recipes.get(out.id)).scope, { account: "", toolkit: "github", area: { id: "o/r", label: "o/r", kind: "repository", where: { owner: "o", repo: "r" } } });
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
  // the request, under the 0.25 an anchor needs, and the agent searched mail, tasks and calendars for 44 s instead.
  it("G4 one thing among many in a result finds its anchor by its own line, and says so", async () => {
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
    assert.ok(recipe, "the calendar anchor is offered");
    assert.ok(recipe.score >= 0.45); // known ground: the fast model answers from it
    assert.deepEqual(recipe.matched, ['Calendar event "Уборка" on 2026-10-03 13:00']);
  });

  // The table shows one sentence about the result (`short`); retrieval embeds the richer summary, not that sentence.
  it("G4b a new anchor gets a one-sentence result description apart from its title, and is found by its result summary", async () => {
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
    assert.equal(recipe.summary, SUMMARY); // the rich text is kept for retrieval and the anchor page
  });

  // An inbox described in English ("Unread emails from today") has no "почта" in it: the keywords written with the
  // summary carry it, in the summary's vector and as a key term.
  it("G4c an anchor is found by the search keywords written with its summary", async () => {
    const SUMMARY = "Five unread emails from today: an invoice from Acme, a meeting invite from Anna.";
    const TEXT = `${SUMMARY}\nKeywords: email, inbox, unread, почта, письма`;
    fakeComposio(
      { messages: [{ subject: "Invoice" }] },
      {
        chat: (prompt) =>
          /Translate it for searching/.test(prompt)
            ? { en: "what is in my mail", terms: ["почта", "mail"] }
            : { title: "Unread emails from today", short: "Who wrote and about what.", summary: SUMMARY, items: [], keywords: ["Email", "inbox", "unread", "почта", "письма", "email"] },
        vector: (t) => (t === TEXT || t.startsWith("что") ? [1, 0, 0] : [0, 1, 0]), // only the summary with its keywords is close
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GMAIL_FETCH_EMAILS", args: { query: "is:unread" } });
    await Promise.all(deferred);
    const recipe = (await genter.search({ query: "что в почте" })).find((r) => r.id === out.id);
    assert.ok(recipe, "found through its keywords");
    assert.deepEqual(recipe.keywords, ["email", "inbox", "unread", "почта", "письма"]); // lowercased, no repeats
    assert.ok(recipe.score >= 0.45);
  });

  it("G5 a key term of the request written in an anchor's result puts it among the anchors, items or not", async () => {
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

  it("G5a the model's terms joined in one string count one by one", async () => {
    fakeComposio(
      { items: [{ subject: "Contract" }] },
      {
        chat: (prompt) =>
          /Translate it for searching/.test(prompt)
            ? { en: "what Anna wrote about the contract", terms: ["Анна; договор", "Anna, contract, agreement"] }
            : { title: "Emails from Anna", summary: "Two emails from Anna: the contract draft and a call.", relevant: true },
        vector: (t) => (t.startsWith("что") ? [1, 0, 0] : [0, 1, 0]), // nothing is close by meaning
      },
    );
    const store = memoryStore();
    const deferred = [];
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: (p) => deferred.push(p) });
    const out = await genter.execute({ tool: "GMAIL_FETCH_EMAILS", args: { query: "from:anna" } });
    await Promise.all(deferred);
    assert.deepEqual((await genter.translate("что Анна писала про договор")).terms, ["Анна", "договор", "Anna", "contract", "agreement"]);
    assert.ok((await genter.search({ query: "что Анна писала про договор" })).some((r) => r.id === out.id), "found by \"contract\" in its summary");
  });

  // "Код продуктовнер в Evallens?" (a dictated "Кто продакт-оунер") went to Google Drive: the site's 72 pages were saved,
  // but no page was close by meaning and the model's terms left the name out.
  it("G5b a request that names a site gets its closest pages first, before anything only close by meaning", async () => {
    const calls = fakeComposio(
      {},
      {
        chat: (prompt) => (/Translate it for searching/.test(prompt) ? { en: "Product owner code in Evallens?", terms: ["Код продуктовнер", "product owner code, owner code"] } : null),
        vector: (t) => (t.startsWith("Код") ? [1, 0, 0] : [0, 1, 0]),
      },
    );
    const store = memoryStore();
    const { seal } = cipher("s:u");
    const put = (id, tool, args, title, summaryEmbedding) =>
      store.put({ id, remembered: true, blob: seal({ id, tool, args, title, summary: title, scope: { account: "", toolkit: tool === "WEBSITE_READ_PAGE" ? "website" : "googledrive" }, status: "fresh", summaryEmbedding }) });
    await put("rcp_drive", "GOOGLEDRIVE_FIND_FILE", { q: "" }, "Files in Google Drive", [0.4, 0.9, 0]); // 0.41: offered by meaning
    await put("rcp_team", "WEBSITE_READ_PAGE", { url: "https://www.evallens.io/team" }, "EvalLens team", [0.1, 0, 1]);
    await put("rcp_news", "WEBSITE_READ_PAGE", { url: "https://evallens.io/news" }, "EvalLens All News page", [0, 0, 1]);
    await put("rcp_terms", "WEBSITE_READ_PAGE", { url: "https://evallens.io/terms" }, "EvalLens terms", [0, 0, 1]);
    await put("rcp_other", "WEBSITE_READ_PAGE", { url: "https://example.org/team" }, "Another site's team", [0.1, 0, 1]);
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, defer: () => {} });

    const found = await genter.search({ query: "Код продуктовнер в Evallens?", limit: 4 });
    assert.deepEqual(found.filter((r) => r.id).map((r) => r.id), ["rcp_team", "rcp_news", "rcp_drive"]); // half the places, the closest page first
    assert.ok(found[0].score >= 0.45 && found[1].score >= 0.45);
    assert.ok(calls.some((u) => u.includes("/tools?") && u.includes("search=")), "tools are still searched");
  });

});

// Anchor = one successful call with fixed args + knowledge about its result: identity, upsert, change detection.
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

  it("R3 a changed result regenerates the same anchor", async () => {
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

  it("R4 a failed call creates no anchor", async () => {
    const { genter, store } = setup(() => ({ __error: "Something broke" }));
    const out = await genter.execute({ tool: "GITHUB_LIST_PULL_REQUESTS", args: { owner: "o", repo: "r" } });
    assert.equal(out.result.successful, false);
    assert.equal(out.id, undefined);
    assert.equal(store.rows.size, 0);
  });

  it("R5 a failure on an existing anchor marks it gone or denied, and search stops offering it", async () => {
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
    assert.equal(c.recipe_status, undefined); // a timeout says nothing about the anchor

    assert.equal((await genter.recipes.get(gone.id)).status, "gone");
    assert.equal((await genter.recipes.get(denied.id)).status, "denied");
    const found = await genter.search({ query: "open pull requests" });
    assert.ok(!found.some((x) => x.id === gone.id || x.id === denied.id));

    failure = null; // the object is back: the same call makes the anchor fresh again
    const back = await genter.execute({ id: gone.id });
    assert.equal(back.recipe_status, "fresh");
    assert.equal((await genter.recipes.get(gone.id)).status, "fresh");
  });

  it("R6 two accounts of one app are two anchors, and revoking one denies only its own", async () => {
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

  it("R8 search returns fresh anchors with their calls, summaries and times, not tool descriptions", async () => {
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

  it("R10 recheck never runs again a saved call that changes something (a sent email is not sent again)", async () => {
    const calls = fakeComposio({ id: "m1" });
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store: memoryStore() });
    const sent = await genter.execute({ tool: "GMAIL_SEND_EMAIL", args: { to: "anna@x.com", body: "hi" } });
    assert.ok(sent.id);
    const before = calls.filter((u) => u.includes("/tools/execute/GMAIL_SEND_EMAIL")).length;
    const again = await genter.recipes.recheck(sent.id);
    assert.equal(again.status, "failed");
    assert.match(again.error, /not run again/);
    assert.equal(calls.filter((u) => u.includes("/tools/execute/GMAIL_SEND_EMAIL")).length, before);
  });
});

describe("triggers of many anchors", () => {
  // Composio's trigger endpoints over fetch, on top of fakeComposio: one trigger type (a commit in a repository), an upsert
  // that makes a NEW trigger each time (so sharing is Genter's doing), enable and disable.
  function fakeTriggers() {
    const seen = { upserts: 0, updates: [] };
    const below = globalThis.fetch;
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const type = { slug: "GITHUB_COMMIT_EVENT", name: "Commit", description: "A new commit", toolkit: { slug: "github", name: "GitHub", logo: "" }, payload: {}, config: { properties: { owner: {}, repo: {} }, required: ["owner", "repo"] } };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/trigger_instances/") && u.includes("/upsert")) return json({ trigger_id: `ti_${++seen.upserts}` });
      if (u.includes("/trigger_instances/manage/")) {
        seen.updates.push([u.split("/").pop().split("?")[0], JSON.parse(init.body).status]);
        return json({ status: "success" });
      }
      if (u.includes("/triggers_types/")) return json(type);
      if (u.includes("/triggers_types")) return json({ items: [type], total_pages: 1 });
      return below(url, init);
    };
    return seen;
  }
  const model = {
    chat: (prompt) =>
      /Which of these triggers/.test(prompt)
        ? { triggers: [{ slug: "GITHUB_COMMIT_EVENT", config: { owner: "o", repo: "r" }, label: "on every commit" }] }
        : { title: `File ${(prompt.match(/"text":"([^"]*)"/) ?? [])[1] ?? ""}`, short: "A file.", summary: (prompt.match(/"text":"([^"]*)"/) ?? [])[1] ?? "A file.", items: [] },
    vector: () => [1, 0, 0],
  };
  const setup = () => {
    let text = { a: "one", b: "one", c: "one" };
    fakeComposio((sent) => ({ text: text[sent.arguments?.path] }), model);
    const seen = fakeTriggers();
    const store = memoryStore();
    const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "u", secret: "s", store, triggers: true });
    const file = async (path) => {
      const out = await genter.execute({ tool: "GITHUB_GET_FILE", args: { owner: "o", repo: "r", path } });
      await out.pending;
      return out.id;
    };
    return { genter, seen, file, set: (path, value) => (text = { ...text, [path]: value }) };
  };

  it("T1 each anchor keeps its own trigger; the same subscription is one Composio trigger, disabled when nobody keeps it", async () => {
    const { genter, seen, file } = setup();
    const [a, b, c] = [await file("a"), await file("b"), await file("c")];
    const on = await genter.recipes.setTriggers({ ids: [a, b], active: true });
    assert.deepEqual(on.map((x) => [x.active, x.label]), [[true, "on every commit"], [true, "on every commit"]]);
    assert.equal(seen.upserts, 1); // one subscription for both
    const id = (await genter.recipes.get(a)).trigger.id;
    assert.equal((await genter.recipes.get(b)).trigger.id, id);
    assert.deepEqual((await genter.recipes.get(a)).trigger.spec, { slug: "GITHUB_COMMIT_EVENT", config: { owner: "o", repo: "r" }, label: "on every commit" });

    await genter.recipes.setTrigger({ id: c, active: true }); // a third one joins the same trigger
    assert.equal(seen.upserts, 1);
    assert.equal((await genter.recipes.get(c)).trigger.id, id);
    assert.deepEqual((await genter.recipes.byTrigger({ triggerId: id })).map((r) => r.id).sort(), [a, b, c].sort());

    await genter.recipes.setTriggers({ ids: [a], active: false });
    assert.deepEqual(seen.updates, []); // b and c still keep it
    assert.deepEqual((await genter.recipes.byTrigger({ triggerId: id })).map((r) => r.id).sort(), [b, c].sort());
    await genter.recipes.remove(b);
    assert.deepEqual(seen.updates, []);
    await genter.recipes.setTriggers({ ids: [c], active: false });
    assert.deepEqual(seen.updates, [[id, "disable"]]);

    await genter.recipes.setTriggers({ ids: [a, c], active: true }); // the old trigger is enabled again, not made anew
    assert.equal(seen.upserts, 1);
    assert.deepEqual(seen.updates.at(-1), [id, "enable"]);
    assert.equal((await genter.recipes.get(c)).trigger.active, true);
  });

  it("T2 an anchor that cannot be turned on says why and stays off; the others are turned on", async () => {
    const { genter, file } = setup();
    const a = await file("a");
    const out = await genter.recipes.setTriggers({ ids: [a, "rcp_missing"], active: true });
    assert.equal(out[0].active, true);
    assert.deepEqual(out[1], { id: "rcp_missing", active: false, label: null, error: "Unknown anchor" });
    await assert.rejects(genter.recipes.setTrigger({ id: "rcp_missing", active: true }), /Unknown anchor/);
  });

  it("T3 a changed result keeps what the anchor said before", async () => {
    const { genter, file, set } = setup();
    const a = await file("a");
    assert.equal((await genter.recipes.get(a)).previous, undefined);
    set("a", "two");
    const again = await genter.recipes.recheck(a);
    assert.equal(again.changed, true);
    const record = await genter.recipes.get(a);
    assert.equal(record.summary, "two");
    assert.equal(record.previous.summary, "one");
    assert.equal(record.previous.title, "File one");
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

  it("Q1 a new question close to a past request (far from the summary) finds the anchor through it", async () => {
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

  it("Q4 asked keeps a request on the anchors an answer used, after the calls, and only on them", async () => {
    const { genter } = setup();
    const answerCall = await genter.execute(call);
    const lookup = await genter.execute({ tool: "GITHUB_LIST_REPOSITORIES", args: { owner: "o" } });
    await Promise.all([answerCall.pending, lookup.pending]);
    await genter.search({ query: "old question about waiting reviews" });
    assert.deepEqual(await genter.recipes.asked({ ids: [answerCall.id, "rcp_missing"], task: "old question about waiting reviews" }), { filed: 1 });
    const found = (await genter.search({ query: "clumsy way to ask it" })).filter((r) => r.id);
    assert.deepEqual(found.map((r) => r.id), [answerCall.id]);
    assert.ok(found[0].score >= 0.9);
    assert.deepEqual(await genter.recipes.asked({ ids: [answerCall.id], task: "  " }), { filed: 0 });
  });

  it("Q3 without a request on the call nothing is kept and the behaviour is as before", async () => {
    const { genter } = setup();
    const out = await genter.execute(call);
    await out.pending;
    assert.equal((await genter.search({ query: "clumsy way to ask it" })).filter((r) => r.id).length, 0);
  });

  it("Q6 a cache miss (no search of this text in this process) embeds the task once, so the link is not lost", async () => {
    const { genter } = setup();
    const out = await genter.execute({ ...call, task: "old question about waiting reviews" });
    await out.pending;
    const recipe = (await genter.search({ query: "clumsy way to ask it" })).find((r) => r.id === out.id);
    assert.ok(recipe, "found through the request embedded on the miss");
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

describe("tool search of the agent: only connected apps", () => {
  // Composio over fetch: the tools of an app (toolkit_slug), or its search over all apps (search alone).
  const tool = (slug, toolkit, description = "") => ({ slug, name: slug, description, toolkit: { slug: toolkit, name: toolkit, logo: "" }, input_parameters: {}, output_parameters: {}, tags: [], version: "1", available_versions: ["1"], scopes: [], no_auth: false, is_deprecated: false });
  const CATALOG = {
    googlecalendar: [tool("GOOGLECALENDAR_ACL_DELETE", "googlecalendar"), tool("GOOGLECALENDAR_EVENTS_LIST", "googlecalendar", "List events of a calendar"), tool("GOOGLECALENDAR_FIND_EVENT", "googlecalendar", "Find events in a calendar")],
    gmail: [tool("GMAIL_FETCH_EMAILS", "gmail", "Fetch emails"), tool("GMAIL_SEND_EMAIL", "gmail", "Send an email")],
  };
  const GLOBAL = [tool("BIGDATA_COM_MCP_BIGDATA_EVENTS_CALENDAR", "bigdata_com_mcp"), tool("CLARIFY_MCP_GET_CALENDAR_EVENTS", "clarify_mcp"), tool("LODGIFY_GET_PROPERTY_AVAILABILITY", "lodgify")];
  const fakeTools = () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (!u.pathname.endsWith("/tools")) return json({ items: [] });
      const toolkit = u.searchParams.get("toolkit_slug");
      return json({ items: toolkit ? (CATALOG[toolkit] ?? []) : GLOBAL, next_cursor: null, total_pages: 1 });
    };
    restore = () => (globalThis.fetch = original);
  };
  const genter = () => createGenter({ composioApiKey: "k", userId: "u", secret: "s", store: memoryStore() });

  it("C1 'What's on my calendar today' with Google Calendar connected: its tools, never another app's calendar tool", async () => {
    fakeTools();
    const found = await genter().search({ query: "What's on my calendar today", limit: 5, apps: ["googlecalendar", "gmail"], connected: true });
    const tools = found.map((f) => f.tool);
    assert.ok(tools.length, "tools found");
    assert.ok(tools.every((t) => t.startsWith("GOOGLECALENDAR_") || t.startsWith("GMAIL_")), tools.join(", "));
    assert.ok(tools[0].startsWith("GOOGLECALENDAR_"), tools.join(", "));
  });

  it("C2 nothing in the query names a connected app: their tools are ranked by its words", async () => {
    fakeTools();
    const tools = (await genter().search({ query: "anything new", limit: 5, apps: ["gmail"], connected: true })).map((f) => f.tool);
    assert.ok(tools.length && tools.every((t) => t.startsWith("GMAIL_")), tools.join(", "));
  });

  it("C3 without connected (the dashboard's tool search) Composio's search over all apps is as before", async () => {
    fakeTools();
    const tools = (await genter().search({ query: "What's on my calendar today", limit: 5, apps: ["googlecalendar"] })).map((f) => f.tool);
    assert.ok(tools.includes("CLARIFY_MCP_GET_CALENDAR_EVENTS"));
  });

  it("C4 an app is meant by a word of its name or what it holds, not only by its slug", () => {
    assert.deepEqual(appsMeant("What's on my calendar today", ["googlecalendar", "gmail", "github"]), ["googlecalendar"]);
    assert.deepEqual(appsMeant("my meetings this week", ["googlecalendar", "gmail"]), ["googlecalendar"]);
    assert.deepEqual(appsMeant("files in my drive", ["googledrive", "github"]), ["googledrive"]);
    assert.deepEqual(appsMeant("unread emails", ["gmail", "github"]), ["gmail"]);
    assert.deepEqual(appsMeant("open pull requests", ["googlecalendar", "gmail"]), []);
  });
});

describe("genter.recipes.reconcile: an area kept whole with no model", () => {
  const files = (list) => ({ sha: "t", truncated: false, tree: list.map(([path, sha]) => ({ path, type: path.includes(".") ? "blob" : "tree", sha })) });
  const setup = (tree) => {
    let current = tree;
    const calls = fakeComposio((sent, u) => (u.includes("GITHUB_GET_A_TREE") ? current : sent.arguments?.path === "broken.md" ? { __error: "500 server error" } : { path: sent.arguments.path, content: `text of ${sent.arguments.path}` }));
    const store = memoryStore();
    const genter = createGenter({ composioApiKey: "k", userId: "u", secret: "s", store, defer: () => {} });
    return { calls, store, genter, set: (t) => (current = t) };
  };
  const reads = (calls) => calls.filter((u) => u.includes("/tools/execute/GITHUB_GET_REPOSITORY_CONTENT")).length;

  it("R1 a new file gets its anchor, a changed sha is checked again, a removed file is gone, a deleted anchor stays deleted", async () => {
    const { calls, genter, set } = setup(files([["a.md", "1"], ["b.md", "1"], ["c.md", "1"], ["src", "d"]]));
    const tree = await genter.execute({ tool: "GITHUB_GET_A_TREE", args: { owner: "o", repo: "r", tree_sha: "main", recursive: true } });
    const ids = {};
    for (const path of ["a.md", "b.md", "c.md"]) ids[path] = (await genter.execute({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path } })).id;
    const listing = { recipe_id: tree.id, tool: "GITHUB_GET_A_TREE", args: { owner: "o", repo: "r", tree_sha: "main", recursive: true }, account: "", read_tool: "GITHUB_GET_REPOSITORY_CONTENT", shared_args: { owner: "o", repo: "r" }, item_arg: "path", item_field: "path", versions: { "a.md": "1", "b.md": "1", "c.md": "1" } };

    // Nothing changed: the tree is listed again and nothing is read.
    let before = reads(calls);
    let out = await genter.recipes.reconcile({ listing });
    assert.equal(out.status, "done");
    assert.deepEqual([out.created, out.changed, out.gone], [[], [], []]);
    assert.equal(reads(calls), before);

    // A person deleted c.md's anchor; then a.md changed (new sha), b.md was removed, new.md and an image were added.
    await genter.recipes.remove(ids["c.md"]);
    set(files([["a.md", "2"], ["c.md", "1"], ["new.md", "1"], ["logo.png", "1"]]));
    before = reads(calls);
    out = await genter.recipes.reconcile({ listing: out.listing });
    assert.equal(out.created.length, 1);
    assert.equal((await genter.recipes.get(out.created[0])).args.path, "new.md");
    assert.deepEqual(out.gone, [ids["b.md"]]);
    assert.equal((await genter.recipes.get(ids["b.md"])).status, "gone");
    assert.equal(out.excluded, 1); // c.md: its anchor was deleted on purpose, it does not come back
    assert.equal(reads(calls) - before, 2); // new.md read, a.md checked again; not c.md, not the image
    assert.equal(out.listing.versions["a.md"], "2");
    assert.equal(out.listing.versions["b.md"], undefined);

    // b.md comes back: its gone anchor is checked again and is fresh.
    set(files([["a.md", "2"], ["b.md", "1"], ["c.md", "1"], ["new.md", "1"]]));
    out = await genter.recipes.reconcile({ listing: out.listing });
    assert.equal((await genter.recipes.get(ids["b.md"])).status, "fresh");
    assert.deepEqual(out.gone, []);
  });

  it("R2 at most `budget` calls (new files first); the rest is pending; a read that keeps failing is given up", async () => {
    const { genter, set } = setup(files([["a.md", "1"]]));
    const tree = await genter.execute({ tool: "GITHUB_GET_A_TREE", args: { owner: "o", repo: "r" } });
    let listing = { recipe_id: tree.id, read_tool: "GITHUB_GET_REPOSITORY_CONTENT", shared_args: { owner: "o", repo: "r" }, item_arg: "path", item_field: "path", account: "", versions: {} };
    set(files([["a.md", "1"], ["broken.md", "1"], ...Array.from({ length: 5 }, (_, i) => [`f${i}.md`, "1"])]));
    let out = await genter.recipes.reconcile({ listing, budget: 3 });
    assert.equal(out.created.length + out.failed, 3);
    assert.equal(out.pending, 4);
    for (let i = 0; i < 6; i++) out = await genter.recipes.reconcile({ listing: out.listing, budget: 3 });
    assert.equal(Object.keys(out.listing.versions).length, 6); // a.md and the five new ones
    assert.equal(out.listing.failed["broken.md"], 3);
    assert.equal(out.pending, 0);
  });

  it("R3 a list that failed or listed nothing touches nothing; a cut list marks nothing gone; inArea knows the area's reads", async () => {
    const { genter, set } = setup(files([["a.md", "1"], ["b.md", "1"]]));
    const tree = await genter.execute({ tool: "GITHUB_GET_A_TREE", args: { owner: "o", repo: "r" } });
    const a = (await genter.execute({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path: "a.md" } })).id;
    const other = (await genter.execute({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "other", path: "a.md" } })).id;
    const listing = { recipe_id: tree.id, read_tool: "GITHUB_GET_REPOSITORY_CONTENT", shared_args: { owner: "o", repo: "r" }, item_arg: "path", item_field: "path", account: "", versions: { "a.md": "1" } };
    assert.deepEqual(await genter.recipes.inArea({ listing, ids: [a, other, tree.id] }), [a]);
    set({ __error: "404 Not Found" });
    let out = await genter.recipes.reconcile({ listing });
    assert.equal(out.status, "failed");
    set({ message: "nothing here" });
    out = await genter.recipes.reconcile({ listing });
    assert.equal(out.status, "failed");
    assert.equal((await genter.recipes.get(a)).status, "fresh");
    set({ sha: "t", truncated: true, tree: [{ path: "b.md", type: "blob", sha: "1" }, { path: "z.md", type: "blob", sha: "1" }] });
    out = await genter.recipes.reconcile({ listing });
    assert.equal(out.partial, true);
    assert.deepEqual(out.gone, []);
  });
});
