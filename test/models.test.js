import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAgent } from "../src/agent.js";
import { usageFields } from "../src/cost.js";
import { createGenter } from "../src/genter.js";
import { GATEWAY_URL, modelApi, OPENROUTER_URL } from "../src/models.js";
import { answer, fakeGenter, memoryRuns } from "./helpers.js";

const original = globalThis.fetch;
afterEach(() => (globalThis.fetch = original));

test("modelApi: AI Gateway when its token is given, else OpenRouter, else none", () => {
  assert.deepEqual(modelApi({ aiGatewayToken: "g", openrouterApiKey: "o" }), { url: GATEWAY_URL, key: "g", name: "AI Gateway" });
  assert.deepEqual(modelApi({ openrouterApiKey: "o" }), { url: OPENROUTER_URL, key: "o", name: "OpenRouter" });
  assert.equal(modelApi({}), null);
});

test("the agent and the engine call AI Gateway with its token", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    if (String(url).endsWith("/embeddings")) return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1 } }) };
    return { ok: true, json: async () => ({ choices: [{ message: answer("done") }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }) };
  };
  const agent = createAgent({ genter: fakeGenter(), aiGatewayToken: "gw", secret: "s", userId: "u", runs: memoryRuns() });
  await agent.start({ task: "hello" });
  const g = createGenter({ composioApiKey: "k", aiGatewayToken: "gw", userId: "u", secret: "s", store: { all: async () => [], get: async () => null, put: async () => {} } });
  await g.search({ query: "когда мне убираться" }).catch(() => {});
  const model = calls.filter((c) => !c.url.includes("composio"));
  assert.ok(model.some((c) => c.url === `${GATEWAY_URL}/chat/completions`));
  assert.ok(model.some((c) => c.url === `${GATEWAY_URL}/embeddings`));
  assert.ok(model.every((c) => c.url.startsWith(GATEWAY_URL) && c.auth === "Bearer gw"), JSON.stringify(model));
});

test("usageFields reads AI Gateway's embeddings cost", () => {
  assert.equal(usageFields({ usage: { prompt_tokens: 2 }, providerMetadata: { gateway: { cost: "0.00000004" } } }).provider_cost_usd, 4e-8);
  assert.equal(usageFields({ usage: { prompt_tokens: 2, cost: 0.1 } }).provider_cost_usd, 0.1);
  assert.equal(usageFields({ usage: { prompt_tokens: 2 } }).provider_cost_usd, undefined);
});
