import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Composio } from "@composio/core";

// Genter = Composio + recipes of past calls.
// A call record is { id, tool, args, created_at, summary, digest, memory }: memory is the recipe description,
// summary is a short retelling of the result (topics, names, ids to open it again). The raw result is never stored.
// Every successful call is saved as a recipe right away; the agent can improve its description later.
// Records are encrypted before they reach the store, so the store only sees rows { id, remembered, blob }
// and needs: get(id), put(row), all() (remembered rows).
export function createGenter({ composioApiKey, openrouterApiKey, userId, secret, store, minScore = 0.45 }) {
  if (!secret) throw new Error("secret is required to encrypt stored calls");
  const composio = new Composio({ apiKey: composioApiKey });
  const { seal, open } = cipher(`${secret}:${userId}`);
  const load = async (id) => {
    const row = await store.get(id);
    if (!row) throw new Error(`Unknown id: ${id}`);
    return open(row.blob);
  };
  const save = (record) => store.put({ id: record.id, remembered: Boolean(record.memory), blob: seal(record) });

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

  // A short retelling of a result, so it can be found later by its topic. Skipped without an OpenRouter key.
  async function summarize(tool, data) {
    if (!openrouterApiKey) return null;
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openrouterApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.SUMMARY_MODEL || "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content:
                `Retell in 1-3 sentences what this ${tool} result contains, so it can be found later by topic: ` +
                "subjects, people, dates, and the ids or URLs needed to open it again. Write in the language of the content. " +
                `No passwords, tokens or keys.\n\n${JSON.stringify(data).slice(0, 20000)}`,
            },
          ],
        }),
      });
      return (await res.json()).choices[0].message.content.trim();
    } catch {
      return null; // a recipe without a summary is still useful
    }
  }

  const api = {
    // Returns a Composio link the user opens to connect an app (gmail, github, ...).
    // callback_url: where Composio sends the user afterwards (with ?status=success|failed).
    async register_tool({ toolkit, callback_url }) {
      const configs = await composio.authConfigs.list({ toolkit });
      const authConfigId =
        configs.items[0]?.id ??
        (await composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name: `${toolkit} auth config` })).id;
      const request = await composio.connectedAccounts.link(userId, authConfigId, callback_url ? { callbackUrl: callback_url } : {});
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
            .map((row) => open(row.blob))
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
              summary: r.summary,
              when: r.created_at,
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

    // Run a tool. Pass `id` to repeat a saved recipe (args are merged on top).
    // Every successful call becomes a recipe: with the agent's description if given, otherwise Composio's.
    async execute({ id, tool, args = {}, description, tags }) {
      const previous = id && (await load(id));
      if (previous) {
        tool ??= previous.tool;
        args = { ...previous.args, ...args };
      }
      if (!tool) throw new Error("Pass `tool` or `id`");
      const result = await composio.tools.execute(tool, { userId, arguments: args, dangerouslySkipVersionCheck: true });
      const outdated = previous?.memory && {
        hint: `If this result does not match the saved description, save recipe ${id} with status "outdated" and say what changed.`,
      };
      if (!result.successful) return { result, ...outdated }; // failed calls are not recipes

      // Same tool, args and result already saved: reuse that recipe instead of a duplicate.
      const digest = createHash("sha256").update(JSON.stringify(result.data)).digest("hex");
      const same = (await store.all())
        .map((row) => open(row.blob))
        .find((r) => r.tool === tool && JSON.stringify(r.args) === JSON.stringify(args) && r.digest === digest);
      const summary = same ? same.summary : await summarize(tool, result.data);
      const record = same ?? { id: randomUUID(), tool, args, created_at: new Date().toISOString(), summary, digest };
      if (!same) await save(record);

      if (description) {
        const [saved] = await api.save_recipes({ recipes: [{ id: record.id, description, tags }] });
        return { id: record.id, result, summary, saved, ...outdated };
      }
      if (!same) {
        const info = await composio.tools.getRawComposioToolBySlug(tool);
        const keys = Object.keys(args).join(", ");
        await api.save_recipes({
          recipes: [{ id: record.id, description: `${info.description} — ${tool}, args: {${keys}}.`, tags: [info.toolkit?.slug].filter(Boolean), auto: true }],
        });
      }
      return {
        id: record.id,
        result,
        summary,
        ...outdated,
        ...((!same || same.memory?.auto) && {
          note:
            "Saved as a recipe with Composio's generic description. Optional: improve it with save_recipes " +
            "(the user's intent in plain words, what it returns, pitfalls, tags in English and Russian).",
        }),
      };
    },

    // Save reusable recipes for calls: each description is embedded for search.
    // Use status "outdated" when a saved recipe no longer does what its description says.
    async save_recipes({ recipes }) {
      return Promise.all(
        recipes.map(async ({ id, description, tags = [], status = "valid", auto }) => {
          const record = await load(id);
          const created_at = new Date().toISOString();
          const embedding = await embed(
            `${description}\nresult: ${record.summary ?? ""}\ntags: ${tags.join(", ")}\ntool: ${record.tool}\nargs: ${JSON.stringify(record.args)}`,
          );
          await save({ ...record, memory: { created_at, tags, description, status, embedding, ...(auto && { auto }) } });
          return { id, created_at, tags, description, status };
        }),
      );
    },
  };
  return api;
}

// AES-256-GCM. Blob = iv (12 bytes) + auth tag (16 bytes) + ciphertext, base64.
function cipher(secret) {
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(value) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    open(blob) {
      const b = Buffer.from(blob, "base64");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
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
