import { embeddingProvider } from "../src/local.js";

// A chat model for the benchmarks' readers and judges, from the same providers as --semantic (OpenAI, OpenRouter,
// Vercel AI Gateway, Ollama, GENTER_EMBED_URL): BENCH_MODEL reads, BENCH_JUDGE judges, gpt-4o-mini by default.
export function chatModel(env = process.env) {
  const p = embeddingProvider({ env });
  const prefixed = p.name === "openrouter" || p.name === "vercel";
  const reader = env.BENCH_MODEL || (prefixed ? "openai/gpt-4o-mini" : p.name === "ollama" ? "llama3.1" : "gpt-4o-mini");
  const judge = env.BENCH_JUDGE || reader;
  const chat = async (model, content, json = false) => {
    const messages = Array.isArray(content) ? content : [{ role: "user", content }];
    const res = await fetch(`${p.url}/chat/completions`, {
      method: "POST",
      headers: { ...(p.key && { Authorization: `Bearer ${p.key}` }), "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, messages, ...(json && { response_format: { type: "json_object" } }) }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`${p.name} ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).choices[0].message.content ?? "";
  };
  return { provider: p.name, reader, judge, chat };
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
