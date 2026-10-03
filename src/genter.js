import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";

// Genter = Composio + memory of past calls.
// `store` keeps call records: { id, tool, args, result, created_at, memory? }
// and needs three methods: get(id), put(record), all().
export function createGenter({ composioApiKey, openrouterApiKey, userId, store, minScore = 0.45 }) {
  const composio = new Composio({ apiKey: composioApiKey });

  // Embeddings via OpenRouter (OpenAI-compatible). Without a key, memory search is skipped.
  async function embed(text) {
    if (!openrouterApiKey) return null;
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small", input: text }),
    });
    if (!res.ok) throw new Error(`Embeddings failed: ${res.status} ${await res.text()}`);
    return (await res.json()).data[0].embedding;
  }

  return {
    // Returns a Composio link the user opens to connect an app (gmail, github, ...).
    async register_tool({ toolkit }) {
      const request = await composio.toolkits.authorize(userId, toolkit);
      return { toolkit, connect_url: request.redirectUrl, connection_id: request.id };
    },

    // Who am I and which apps are connected.
    async login() {
      const { items } = await composio.connectedAccounts.list({ userIds: [userId] });
      return { user_id: userId, connected: items.map((a) => ({ toolkit: a.toolkit.slug, status: a.status })) };
    },

    // Memory first (ready-made calls with args), plain Composio search as fallback.
    async search({ query, limit = 5 }) {
      const vector = await embed(query);
      const memories = vector
        ? (await store.all())
            .filter((r) => r.memory?.embedding)
            .map((r) => ({ ...r, score: cosine(vector, r.memory.embedding) }))
            .filter((r) => r.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((r) => ({
              id: r.id,
              tool: r.tool,
              args: r.args,
              tags: r.memory.tags,
              description: r.memory.description,
              status: r.memory.status,
            }))
        : [];
      if (memories.some((m) => m.status === "valid")) return memories;

      const tools = await composio.tools.getRawComposioTools({ search: query, limit });
      const found = tools.map((t) => ({
        id: null,
        tool: t.slug,
        args: t.inputParameters, // JSON schema of the arguments
        tags: [t.toolkit?.slug, ...(t.tags ?? [])].filter(Boolean),
        description: t.description,
        status: "new",
      }));
      return [...memories, ...found];
    },

    // Run a tool. Pass `id` to repeat a remembered call (args are merged on top).
    async execute({ id, tool, args = {} }) {
      if (id) {
        const previous = await store.get(id);
        if (!previous) throw new Error(`Unknown id: ${id}`);
        tool ??= previous.tool;
        args = { ...previous.args, ...args };
      }
      if (!tool) throw new Error("Pass `tool` or `id`");
      const result = await composio.tools.execute(tool, { userId, arguments: args, dangerouslySkipVersionCheck: true });
      const record = { id: randomUUID(), tool, args, result, created_at: new Date().toISOString() };
      await store.put(record);
      return { id: record.id, result };
    },

    // Describe what a call returned. The description is embedded for search.
    // Use status "outdated" when a remembered call no longer does what its description says.
    async add_memory({ id, description, tags = [], status = "valid" }) {
      const record = await store.get(id);
      if (!record) throw new Error(`Unknown id: ${id}`);
      const created_at = new Date().toISOString();
      const embedding = await embed(`${description}\ntags: ${tags.join(", ")}\ntool: ${record.tool}\nargs: ${JSON.stringify(record.args)}`);
      await store.put({ ...record, memory: { created_at, tags, description, status, embedding } });
      return { id, created_at, tags, description, status };
    },
  };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}
