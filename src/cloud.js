// Genter Cloud from the command: a `gnt_` token of a workspace (Settings → API tokens) lets `genter ask` and the MCP
// server's genter_find also find in the workspace's apps, through the hosted API (POST /api/v1/cli/find). No package.

export const CLOUD_URL = "https://genter.ai";
export const TOKENS_PAGE = `${CLOUD_URL}/dashboard/settings`;

// The token and address to use: GENTER_TOKEN / GENTER_URL, else what `genter login` kept. null when signed out.
export function cloudOf({ env = process.env, config = {} } = {}) {
  const token = env.GENTER_TOKEN || config.cloud?.token;
  if (!token) return null;
  return { token, url: (env.GENTER_URL || config.cloud?.url || CLOUD_URL).replace(/\/+$/, ""), workspace: config.cloud?.workspace ?? null };
}

async function call(cloud, path, body, timeout) {
  let res;
  try {
    res = await fetch(`${cloud.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${cloud.token}`, ...(body && { "Content-Type": "application/json" }), "User-Agent": "genter-cli" },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`Genter Cloud did not answer (${cloud.url}): ${e.cause?.code ?? e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = res.status === 401 ? `the token was refused: make one in ${TOKENS_PAGE} and run genter login <token>` : data.error ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`Genter Cloud: ${why}`), { status: res.status, code: data.code });
  }
  return data;
}

// Who the token is: { user, workspace } (GET /api/v1/me).
export async function whoami(cloud) {
  if (!/^gnt_[\w-]{20,}$/.test(cloud.token)) throw new Error(`A Genter token starts with gnt_: make one in ${TOKENS_PAGE}`);
  const me = await call(cloud, "/api/v1/me", null, 20000);
  if (!me.user) throw new Error(`Genter Cloud: the token was refused: make one in ${TOKENS_PAGE}`);
  return { user: me.user.email ?? me.user.name ?? me.user.id, workspace: me.ws?.name ?? null, plan: me.credits?.name ?? me.credits?.plan ?? null };
}

// Genter's agent finds the answer in the workspace's apps (read-only; it costs the workspace's credits).
// { text, references, status }: text is the answer with its sources, as the hosted CLI prints it.
export async function cloudFind(cloud, question, { timeout = 180000 } = {}) {
  const { result } = await call(cloud, "/api/v1/cli/find", { question }, timeout);
  return { text: String(result?.text ?? result?.answer ?? "").trim(), references: result?.references ?? [], status: result?.status ?? null };
}

// The cloud's part of an answer as text, under a line naming the workspace.
export const cloudText = (found, cloud) => `From your apps · Genter Cloud${cloud.workspace ? ` (${cloud.workspace})` : ""}:\n\n${found.text || "Nothing found."}`;
