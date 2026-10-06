import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createAgent } from "../src/agent.js";
import { costContext, estimateCost, logCost, PRICES, setCostSink, withCost } from "../src/cost.js";
import { createGenter } from "../src/genter.js";
import { answer, fakeGenter, memoryRuns } from "./helpers.js";

let events;
let original;
beforeEach(() => {
  events = [];
  original = globalThis.fetch;
  setCostSink((e) => events.push(e));
});
afterEach(() => {
  globalThis.fetch = original;
  setCostSink(null);
});

test("estimateCost is tokens × the configured price", () => {
  const p = PRICES["openai/gpt-oss-120b"];
  assert.equal(estimateCost({ model: "openai/gpt-oss-120b", tokens_in: 1_000_000, tokens_out: 1_000_000 }), p.in + p.out);
  assert.equal(estimateCost({ model: "openai/text-embedding-3-small", tokens_in: 1_000_000 }), 0.02);
  assert.equal(estimateCost({ model: "nobody/unknown", tokens_in: 5 }), null);
});

test("COST_PRICES overrides prices", () => {
  process.env.COST_PRICES = JSON.stringify({ "x/y": { in: 1, out: 2 } });
  try {
    assert.equal(estimateCost({ model: "x/y", tokens_in: 1e6, tokens_out: 1e6 }), 3);
  } finally {
    delete process.env.COST_PRICES;
  }
});

test("withCost attribution reaches the event; inner values win; fields are metadata only", () => {
  withCost({ org_id: "ws1", user_id: "u1" }, () =>
    withCost({ action: "generate_project", entity_type: "skill", entity_id: "skl_1" }, () => {
      assert.equal(costContext().org_id, "ws1");
      logCost({ type: "llm", model: "openai/gpt-oss-120b", source: "search", tokens_in: 1000, tokens_out: 100, prompt: "SECRET" });
    }),
  );
  const [e] = events;
  assert.equal(e.org_id, "ws1");
  assert.equal(e.user_id, "u1");
  assert.equal(e.source, "search");
  assert.equal(e.entity_id, "skl_1");
  assert.equal(e.action, "generate_project");
  assert.ok(e.cost_usd_estimate > 0);
  assert.ok(!JSON.stringify(e).includes("SECRET"));
});

const embeddingsFetch = (usage) => async (url, init) => {
  assert.match(String(url), /embeddings/);
  const n = [].concat(JSON.parse(init.body).input).length;
  return { ok: true, json: async () => ({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [0.1, 0.2] })), usage }) };
};

test("embedMany: one event per request with texts, tokens and a nonzero estimate", async () => {
  globalThis.fetch = embeddingsFetch({ prompt_tokens: 120 });
  const g = createGenter({ composioApiKey: "k", openrouterApiKey: "k", userId: "u", secret: "s", store: { all: async () => [], get: async () => null, put: async () => {} }, knowledge: { all: async () => [] } });
  assert.ok(g);
  // the engine's embeddings are reached through recipes.search -> embed; use the public search path
  await withCost({ org_id: "ws1", user_id: "u1" }, () => g.search({ query: "когда мне убираться" }).catch(() => {}));
  const e = events.find((x) => x.type === "embedding");
  assert.ok(e, `no embedding event; got ${JSON.stringify(events)}`);
  {
    assert.equal(e.org_id, "ws1");
    assert.equal(e.model, "openai/text-embedding-3-small");
    assert.equal(e.source, "search_embed");
    assert.ok(e.tokens_in > 0 && e.cost_usd_estimate > 0);
  }
});

test("agent step: an llm event with tokens, model, source and attribution", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: answer("done") }], usage: { prompt_tokens: 2000, completion_tokens: 300, cost: 0.0004 } }) });
  const agent = createAgent({ genter: fakeGenter(), openrouterApiKey: "k", secret: "s", userId: "u", runs: memoryRuns() });
  await withCost({ org_id: "ws1", user_id: "u1", request_id: "req1" }, () => agent.start({ task: "hello" }));
  const llm = events.filter((e) => e.type === "llm");
  assert.ok(llm.length >= 1);
  const e = llm[0];
  assert.equal(e.source, "agent_step");
  assert.equal(e.model, "openai/gpt-oss-120b");
  assert.equal(e.tokens_in, 2000);
  assert.equal(e.tokens_out, 300);
  assert.equal(e.cost_usd_reported, 0.0004);
  assert.ok(e.cost_usd_estimate > 0);
  assert.equal(e.request_id, "req1");
  assert.equal(e.org_id, "ws1");
});
