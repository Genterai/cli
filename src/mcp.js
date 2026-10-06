import { createHash } from "node:crypto";
import { publicFetch } from "./net.js";

// Remote MCP servers Composio has no toolkit for, added to Composio as custom toolkits, so their tools are called like
// any app's. One address is one toolkit (its slug comes from the address: custom_mcp_<name>_<hash>); how it signs in
// is found by asking the server: nothing, OAuth with Dynamic Client Registration, or an API key Composio asks for.

const COMPOSIO = () => process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";

// The address as it is compared everywhere: https, lower-case host, no fragment, no trailing slash.
export function mcpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Pass the MCP server's address, e.g. https://mcp.example.com/mcp");
  }
  if (u.protocol !== "https:") throw new Error("An MCP server's address starts with https://");
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

// https://mcp.linear.app/mcp -> MCP_LINEAR_1A2B3C4D, https://gateway.pipeworx.io/wikipedia/mcp ->
// MCP_PIPEWORX_WIKIPEDI_<hash> (Composio adds CUSTOM_): the agent reads it in every tool's name.
const GENERIC = new Set(["mcp", "www", "api", "server", "servers", "gateway", "app", "apps", "sse", "http", "stream", "v1", "v2", "v3", "remote"]);
export function mcpSlug(url) {
  const u = new URL(url);
  const host = u.hostname.split(".").slice(0, -1).find((label) => !GENERIC.has(label));
  const path = u.pathname.split("/").find((segment) => segment && !GENERIC.has(segment.toLowerCase()));
  const name = [host, path].filter(Boolean).join("_").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 17).replace(/_+$/, ""); // a slug is at most 30 characters
  return `MCP_${name || "SERVER"}_${createHash("sha256").update(url).digest("hex").slice(0, 8).toUpperCase()}`;
}

export const isCustomToolkit = (slug) => String(slug ?? "").toLowerCase().startsWith("custom_");

async function composioApi(apiKey, method, path, body) {
  const res = await fetch(`${COMPOSIO()}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const why = [data?.error?.message ?? data?.message ?? text.slice(0, 200), ...(data?.error?.errors ?? [])].join("; ");
  if (!res.ok) throw Object.assign(new Error(`Adding the server failed (${res.status}): ${why}`), { status: res.status });
  return data;
}

const json = async (url) => {
  try {
    const { res } = await publicFetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

// OAuth metadata of an authorization server (RFC 8414, then OpenID): { url, doc } or null.
async function discovery(issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  for (const url of [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]) {
    const doc = await json(url);
    if (doc?.authorization_endpoint) return { url, doc };
  }
  return null;
}

// How the server signs in, from its answer to an MCP initialize: a Composio auth scheme.
export async function authOf(url) {
  let res;
  try {
    ({ res } = await publicFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "genter", version: "1" } },
      }),
      signal: AbortSignal.timeout(15_000),
    }));
  } catch (e) {
    throw new Error(`${url} does not answer: ${e.cause?.message ?? e.message}`);
  }
  await res.body?.cancel().catch(() => {});
  if (res.ok) {
    // An MCP server answers initialize with JSON-RPC, as JSON or as an event stream.
    if (/json|event-stream/i.test(res.headers.get("content-type") ?? "")) return { mode: "NO_AUTH" };
    throw new Error(`${url} is not an MCP server (it answers ${res.headers.get("content-type") || "something else"})`);
  }
  if (res.status >= 500) throw new Error(`${url} answers ${res.status}: the server has a problem, try again later`);
  if (res.status !== 401 && res.status !== 403) throw new Error(`${url} answers ${res.status}: is it the MCP server's address (often ending in /mcp)?`);
  const origin = new URL(url).origin;
  const metadata = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];
  const resource = (metadata && (await json(new URL(metadata, url).toString()))) || (await json(`${origin}/.well-known/oauth-protected-resource`));
  const found = await discovery(resource?.authorization_servers?.[0] ?? origin);
  if (found?.doc.registration_endpoint) return { mode: "DCR_OAUTH", discovery_url: found.url };
  return apiKeyScheme();
}

// An API key, sent as a Bearer token or in a header of its own; Composio asks the person for it.
const apiKeyScheme = (header) =>
  !header || /^authorization$/i.test(header)
    ? { mode: "API_KEY", headers: { Authorization: "Bearer {{generic_api_key}}" } }
    : { mode: "API_KEY", headers: { [header]: "{{generic_api_key}}" } };

// Adds the server to Composio (again: the same address answers the same toolkit): { toolkit, auth, url }.
// api_key_header: the server takes an API key in this header (a registry entry says so); otherwise the server is asked.
export async function addMcpServer({ apiKey, url: raw, name, api_key_header }) {
  const url = mcpUrl(raw);
  const scheme = api_key_header ? apiKeyScheme(api_key_header) : await authOf(url);
  const slug = mcpSlug(url);
  const label = String(name ?? "").trim().slice(0, 60) || new URL(url).hostname;
  try {
    const out = await composioApi(apiKey, "POST", "/api/v3.1/custom/toolkits/upsert", { slug, toolkit_config: { name: label, app_url: url, auth_schemes: [scheme] } });
    return { toolkit: out.slug.toLowerCase(), auth: scheme.mode, url };
  } catch (e) {
    // Added before with another sign-in, which can not change (409), or Composio still reading a slow server's tools
    // when the answer timed out: the toolkit as it is, if it is there.
    if (e.status !== 409 && e.name !== "TimeoutError") throw e;
    const t = await composioApi(apiKey, "GET", `/api/v3/toolkits/CUSTOM_${slug}`).catch(() => null);
    if (!t) throw e.name === "TimeoutError" ? new Error(`Adding ${url} took too long; try again in a minute`) : e;
    return { toolkit: t.slug.toLowerCase(), auth: t.auth_config_details?.[0]?.mode ?? scheme.mode, url };
  }
}
