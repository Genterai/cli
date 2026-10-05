import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Fetching addresses people type in (an MCP server, a website): only public hosts, never this machine or its network,
// also after a redirect.

const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"];

const v4 = (ip) => ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
function privateV4(ip) {
  const n = v4(ip);
  return PRIVATE_V4.some((cidr) => {
    const [base, bits] = cidr.split("/");
    return n >= v4(base) && n < v4(base) + 2 ** (32 - Number(bits));
  });
}

export function privateAddress(ip) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateV4(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6); // how URL writes a mapped address
  if (hex) return privateV4([hex[1], hex[2]].flatMap((h) => [parseInt(h, 16) >> 8, parseInt(h, 16) & 255]).join("."));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

// Throws unless the URL is http(s) on a host that resolves only to public addresses.
export async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${url}: only http and https addresses`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(localhost|local|internal|localdomain)$/i.test(host)) throw new Error(`${u.hostname} is not a public address`);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new Error(`${u.hostname} does not resolve`);
  if (addresses.some(privateAddress)) throw new Error(`${u.hostname} is not a public address`);
}

// fetch with redirects followed by hand, each hop checked. Answers { res, url } (url: where it ended up).
export async function publicFetch(url, init = {}, { redirects = 5 } = {}) {
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (!location) return { res, url };
    await res.body?.cancel().catch(() => {});
    if (hop >= redirects) throw new Error(`${url}: too many redirects`);
    url = new URL(location, url).toString();
  }
}

// A body as text, at most `max` bytes (the rest is not downloaded).
export async function textOf(res, max = 2_000_000) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, max));
}
