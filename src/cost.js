import { AsyncLocalStorage } from "node:async_hooks";

// Cost observability: every paid call (a model call or an embeddings call) writes ONE structured event with an estimate
// of its cost in USD and who/what it was for. Only metadata: never prompts, texts, results or keys.
//
// Where it goes: one JSON line on stdout (the platform's log drain ships it to BetterStack, the way the other logs go),
// and, when BETTERSTACK_INGEST_URL and a token (BETTERSTACK_SOURCE_TOKEN, else the existing BETTERSTACK_API_KEY) are set, straight to a BetterStack source over HTTP.
// GENTER_COST_LOG=0 turns the stdout line off (the CLI sets it, so a terminal stays quiet).

// USD per 1M tokens: { in, out }. The one place to update prices. COST_PRICES (JSON, same shape) overrides or adds models.
export const PRICES = {
  "openai/gpt-oss-120b": { in: 0.1, out: 0.5 },
  "google/gemma-4-31b-it": { in: 0.14, out: 0.4 },
  "openai/text-embedding-3-small": { in: 0.02, out: 0 },
  "openai/text-embedding-3-large": { in: 0.13, out: 0 },
};

function priceOf(model) {
  try {
    const own = JSON.parse(process.env.COST_PRICES || "{}")[model];
    if (own) return own;
  } catch {}
  return PRICES[model] ?? null;
}

// tokens × price. null when the model has no price (the event says so with price_known: false).
export function estimateCost({ model, tokens_in = 0, tokens_out = 0 }) {
  const p = priceOf(model);
  if (!p) return null;
  return ((tokens_in * (p.in ?? 0)) + (tokens_out * (p.out ?? 0))) / 1e6;
}

// ---- Attribution ----
// Fields that say who and what a call was for: org_id (workspace), user_id, action (what the person did: search,
// generate_project, skill_add, skill_update, recipe_execute...), source (the call site: agent_step, recipe_summary,
// skill_embed...), entity_type + entity_id (skill_id, project_id, recipe_id), request_id, run_id, via.
const als = new AsyncLocalStorage();

// Runs fn with these fields added to every cost event made inside it (inner values win over outer ones).
export const withCost = (attrs, fn) => als.run({ ...als.getStore(), ...clean(attrs) }, fn);
export const costContext = () => als.getStore() ?? {};

const clean = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));

// ---- Sinks ----
let sink = null;
// Tests and hosts can take the events themselves: setCostSink(fn) (null to go back to the default).
export const setCostSink = (fn) => (sink = fn);

function ingest(event) {
  const url = process.env.BETTERSTACK_INGEST_URL;
  const token = process.env.BETTERSTACK_SOURCE_TOKEN || process.env.BETTERSTACK_API_KEY; // the key already synced from Infisical
  if (!url || !token) return;
  fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {}); // observability never breaks a call
}

// text -> a rough token count, for providers that do not report one (4 characters per token).
export const roughTokens = (texts) => Math.ceil([].concat(texts ?? []).reduce((n, t) => n + String(t ?? "").length, 0) / 4);

// Logs one paid call. fields:
//   type: "llm" | "embedding"; model; source (what the call is for); ok (default true); ms
//   tokens_in, tokens_out (llm), or texts + tokens_in (embedding); provider_cost_usd (what the provider reported, if it did)
//   any attribution field (org_id, user_id, entity_type, entity_id, request_id, run_id, via) overrides the context
export function logCost(fields) {
  try {
    const f = { ...costContext(), ...clean(fields) };
    const type = f.type === "embedding" ? "embedding" : "llm";
    const tokens_in = Math.round(Number(f.tokens_in) || 0);
    const tokens_out = Math.round(Number(f.tokens_out) || 0);
    const estimate = estimateCost({ model: f.model, tokens_in, tokens_out });
    const event = {
      event: "cost",
      message: `cost ${type} ${f.model ?? "unknown"} ${f.source ?? "unknown"}`,
      dt: new Date().toISOString(),
      level: f.ok === false ? "warn" : "info",
      type,
      model: f.model ?? "unknown",
      source: f.source ?? "unknown",
      ok: f.ok !== false,
      tokens_in,
      tokens_out,
      ...(type === "embedding" && { texts: f.texts ?? 0 }),
      ...(f.tokens_estimated && { tokens_estimated: true }),
      cost_usd_estimate: estimate ?? 0,
      price_known: estimate != null,
      ...(f.provider_cost_usd != null && { cost_usd_reported: Number(f.provider_cost_usd) || 0 }),
      ...(f.ms != null && { ms: Math.round(f.ms) }),
      ...Object.fromEntries(["org_id", "user_id", "action", "entity_type", "entity_id", "request_id", "run_id", "via", "kind"].filter((k) => f[k] != null).map((k) => [k, f[k]])),
    };
    if (sink) sink(event);
    else if (process.env.GENTER_COST_LOG !== "0") console.log(JSON.stringify(event));
    ingest(event);
  } catch {} // never let logging break a paid call
}

// OpenRouter's reply -> the fields for logCost (chat: usage.prompt_tokens/completion_tokens/cost; embeddings: prompt_tokens/cost).
export const usageFields = (data) => ({
  tokens_in: data?.usage?.prompt_tokens,
  tokens_out: data?.usage?.completion_tokens,
  provider_cost_usd: data?.usage?.cost,
});
