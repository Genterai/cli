import { redirectOf } from "./drift.js";
import { createHash } from "node:crypto";
import { publicFetch, textOf } from "./net.js";

// Websites: a page is read by a local tool, WEBSITE_READ_PAGE {url} -> { url, title, text }, and becomes an anchor like
// any call (genter.js). Connecting a site is preparing an area: crawl() finds its pages (the address and the pages it
// links to on the same site, up to two links deep), then each page is one execute. Pages the crawl just read are
// kept for a few minutes, so the executes that follow do not download them again.

export const WEBSITE = { maxDepth: 2, maxPages: 120, pageBytes: 2_000_000, pageMs: 12_000, budgetMs: 45_000, readers: 6 };

const SKIP = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|pdf|zip|gz|tgz|rar|7z|tar|mp[34]|mov|avi|webm|wav|ogg|woff2?|ttf|otf|eot|css|js|json|xml|rss|atom|exe|dmg|apk|csv|xlsx?|docx?|pptx?)$/i;
const AGENT = "GenterBot/1.0 (+https://genter.ai)";

// The address a person typed, as the crawl's start: https:// added when missing, no fragment.
export function siteUrl(raw) {
  const text = String(raw ?? "").trim();
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("Pass the site's address, e.g. https://docs.example.com");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("A website's address starts with https://");
  if (!u.hostname.includes(".")) throw new Error(`${u.hostname} is not a website's address`);
  u.hash = "";
  return u.toString();
}

const sameSite = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
const folderOf = (u) => (u.pathname.endsWith("/") ? u.pathname : u.pathname.replace(/[^/]*$/, ""));

// A page of this site: its host (www or not) and under the site address's folder.
export function underSite(page, site) {
  try {
    const p = new URL(page);
    const s = new URL(siteUrl(site));
    return sameSite(p.hostname, s.hostname) && p.pathname.startsWith(folderOf(s));
  } catch {
    return false;
  }
}

// What people call a site: the name its domain is registered under, without www, the ending (.io, .co.uk) and the host
// it lives on ("evallens" for https://www.evallens.io/team, "acme" for docs.acme.co.uk and acme.github.io). null for
// an IP address or a name of under 3 letters.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
const HOSTS = new Set(["github", "gitlab", "vercel", "netlify", "pages", "herokuapp", "notion", "gitbook", "webflow", "framer", "wordpress", "blogspot", "substack", "medium", "readthedocs", "firebaseapp", "web", "appspot", "wixsite", "tilda", "myshopify"]);
export function siteName(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return null;
  const labels = host.split(".").filter((l) => l && l !== "www");
  labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels.at(-1))) labels.pop();
  if (labels.length > 1 && HOSTS.has(labels.at(-1))) labels.pop();
  const name = labels.at(-1)?.replace(/[^\p{L}\p{N}]/gu, "");
  return name && name.length >= 3 ? name : null;
}

// Whether a text names the site of this page: a word of it, or two words written together, is the site's name
// ("Evallens?", "EvalLens.io" and "Eval Lens" name evallens.io).
export function namesSite(text, url) {
  const name = siteName(url);
  if (!name) return false;
  const words = String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((w, i) => w === name || w + (words[i + 1] ?? "") === name);
}

// A link as a page to visit: same site, under the start's folder, not a file; no fragment and no tracking params.
function pageLink(href, base, start) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !sameSite(u.hostname, start.hostname)) return null;
  if (!u.pathname.startsWith(start.folder) || SKIP.test(u.pathname)) return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(key)) u.searchParams.delete(key);
  return u.toString();
}

// robots.txt rules for every crawler (User-agent: *): paths that are off limits.
async function robots(origin) {
  try {
    const { res } = await publicFetch(`${origin}/robots.txt`, { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const lines = (await textOf(res, 200_000)).split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim());
    const out = [];
    let mine = false;
    let grouped = false;
    for (const line of lines) {
      const [, key, value = ""] = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line) ?? [];
      if (!key) continue;
      if (/^user-agent$/i.test(key)) {
        if (grouped) mine = false;
        grouped = false;
        if (value === "*" || /genter/i.test(value)) mine = true;
      } else {
        grouped = true;
        if (mine && /^disallow$/i.test(key) && value) out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

// An HTML page as { title, text, links }: headings, paragraphs and lists as Markdown-ish text, without scripts,
// styles, navigation and footers (they repeat on every page).
export function htmlText(html) {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const base = /<base[^>]+href=["']([^"']+)["']/i.exec(html)?.[1];
  const links = [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => decode(m[1] ?? m[2] ?? m[3] ?? ""));
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ");
  body = body
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|aside|ul|ol|table|tr|blockquote|pre|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^[ |]+$/gm, "") // layout tables leave rows of empty cells
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links, base };
}

async function page(url, rules) {
  const path = new URL(url).pathname;
  if (rules.some((rule) => path.startsWith(rule))) return null;
  const { res, url: final } = await publicFetch(url, {
    headers: { "User-Agent": AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
    signal: AbortSignal.timeout(WEBSITE.pageMs),
  });
  const type = res.headers.get("content-type") ?? "";
  const lastModified = res.headers.get("last-modified") ?? undefined;
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {});
    return { missing: res.status };
  }
  if (!res.ok || !/text\/(html|plain|markdown)|application\/xhtml/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const raw = await textOf(res, WEBSITE.pageBytes);
  // Plain text or Markdown (some sites answer it to non-browsers): its first heading and its links.
  if (!/html/i.test(type)) {
    const text = raw.trim();
    const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1].replace(/\s*\(\/[^)]*\)\s*$/, "").trim();
    const links = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
    return { url: final, title: heading || new URL(final).pathname, text, links, base: final, lastModified };
  }
  if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(raw)) return null;
  const { title, text, links, base } = htmlText(raw);
  return { url: final, title: title || new URL(final).pathname, text, links, base: base ? new URL(base, final).toString() : final, lastModified };
}

// Pages read lately: url -> { at, page }.
const recent = new Map();
const RECENT_MS = 10 * 60_000;
const remember = (url, got, source) => {
  recent.set(url, { at: Date.now(), page: got, ...(source && { source }) });
  if (recent.size > 2000) recent.delete(recent.keys().next().value);
};

// A page to be read again from the site, not from what a crawl just read.
export const forgetPage = (url) => {
  try {
    recent.delete(siteUrl(url));
  } catch {}
};

// { last_modified?, redirect? }: the Last-Modified header, and the final address when it is not the one asked for.
const pageSource = (asked, got) => {
  const redirect = redirectOf(asked, got.url);
  return got.lastModified || redirect ? { ...(got.lastModified && { last_modified: got.lastModified }), ...(redirect && { redirect }) } : undefined;
};

// The tool: one page as { successful, data: { url, title, text } }. A page that is gone answers 404 (its anchor is
// then marked gone); one that could not be read (down, not text) is a failure that says nothing about the anchor.
export async function readPage({ url } = {}) {
  let target;
  try {
    target = siteUrl(url);
  } catch (e) {
    return { successful: false, error: e.message, data: null };
  }
  const hit = recent.get(target);
  if (hit && Date.now() - hit.at < RECENT_MS) return { successful: true, data: hit.page, ...(hit.source && { source: hit.source }) };
  try {
    const got = await page(target, []);
    if (got?.missing) return { successful: false, error: `${target}: not found (${got.missing})`, data: null };
    if (!got?.text) return { successful: false, error: `${target}: no text to read`, data: null };
    const data = { url: got.url, title: got.title, text: got.text };
    // Anchor Drift: what the HTTP answer said about the page, kept beside the data (never in it: the digest stays the text's).
    const source = pageSource(target, got);
    remember(target, data, source);
    return { successful: true, data, ...(source && { source }) };
  } catch (e) {
    return { successful: false, error: `${target}: ${e.cause?.message ?? e.message}`, data: null };
  }
}

// The pages of a site: { successful, data: { pages: [{ url, title, text, hash, size }], complete } }.
// depth: links to follow from the start (0-2, default 2); max: pages at most. Every page read is kept for readPage.
export async function crawl({ url, depth, max = WEBSITE.maxPages, budgetMs = WEBSITE.budgetMs } = {}) {
  const started = Date.now();
  const first = new URL(siteUrl(url));
  const levels = Math.max(0, Math.min(WEBSITE.maxDepth, depth === undefined || depth === "" ? WEBSITE.maxDepth : Number(depth) || 0));
  const limit = Math.max(1, Math.min(WEBSITE.maxPages, Number(max) || WEBSITE.maxPages));
  // Only pages under the start's folder: docs.example.com/guide/ stays in /guide/.
  const start = { hostname: first.hostname, folder: folderOf(first) };
  const rules = await robots(first.origin);
  const seen = new Set([first.toString()]);
  const texts = new Set();
  const pages = [];
  let complete = true;
  let level = [first.toString()];
  for (let d = 0; d <= levels && level.length; d++) {
    const next = [];
    let i = 0;
    const worker = async () => {
      while (i < level.length) {
        if (pages.length >= limit) return;
        if (Date.now() - started > budgetMs) {
          complete = false;
          return;
        }
        const url = level[i++];
        const got = await page(url, rules).catch(() => null);
        if (!got?.text) continue;
        seen.add(got.url);
        const hash = createHash("sha256").update(got.text).digest("hex").slice(0, 16);
        // The same text under another address (a redirect, ?ref=) is one page.
        if (!got.text || texts.has(hash) || pages.length >= limit) continue;
        texts.add(hash);
        pages.push({ url: got.url, title: got.title, text: got.text, hash, size: got.text.length });
        remember(url, { url: got.url, title: got.title, text: got.text }, pageSource(url, got));
        if (got.url !== url) remember(got.url, { url: got.url, title: got.title, text: got.text }, pageSource(got.url, got));
        if (d < levels) {
          for (const href of got.links) {
            const link = pageLink(href, got.base, start);
            if (link && !seen.has(link)) {
              seen.add(link);
              next.push(link);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: WEBSITE.readers }, worker));
    if (i < level.length && pages.length < limit) complete = false;
    level = next;
  }
  if (!pages.length) return { successful: false, error: `${first.hostname}: no page could be read (is the address right, is the site up?)`, data: {} };
  return { successful: true, data: { pages, complete } };
}
