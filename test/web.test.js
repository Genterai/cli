import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpSlug, mcpUrl } from "../src/mcp.js";
import { privateAddress } from "../src/net.js";
import { createSources } from "../src/sync.js";
import { htmlText, siteUrl } from "../src/web.js";

function memoryKnowledge() {
  const sources = new Map();
  const items = new Map();
  return {
    getSource: async (id) => sources.get(id),
    putSource: async (row) => sources.set(row.id, row),
    deleteSource: async (id) => sources.delete(id),
    sources: async () => [...sources.values()],
    items: async (sourceId) => [...items.values()].filter((r) => r.source_id === sourceId),
    putItems: async (rows) => rows.forEach((r) => items.set(`${r.source_id}:${r.key}`, r)),
    deleteItems: async (sourceId, keys) => keys.forEach((k) => items.delete(`${sourceId}:${k}`)),
    allItems: async () => [...items.values()],
  };
}

// A website source over a fake crawl: each call answers the next response.
function siteSources(responses) {
  const calls = [];
  const sources = createSources({
    run: async (tool, args) => {
      calls.push({ tool, args });
      return responses.shift();
    },
    embedMany: async (texts) => texts.map((t) => [t.length % 7, 1]),
    seal: (v) => JSON.stringify(v),
    open: (b) => JSON.parse(b),
    store: memoryKnowledge(),
  });
  return { sources, calls };
}
const pageOf = (url, text) => ({ url, title: url, text, hash: `h:${text}`, size: text.length });

describe("Websites", () => {
  it("W1 a site is a source checked every hour: pages from the crawl, only changed ones read again", async () => {
    const { sources, calls } = siteSources([
      { successful: true, data: { complete: true, pages: [pageOf("https://a.dev/", "home"), pageOf("https://a.dev/b", "bee")] } },
      { successful: true, data: { complete: true, pages: [pageOf("https://a.dev/", "home v2")] } },
    ]);
    const source = await sources.create({ template: "website", scope: { url: "https://a.dev/" } });
    assert.equal(source.toolkit, "website");
    assert.equal(source.every, 60);
    let synced = await sources.sync({ id: source.id, budgetMs: 10_000 });
    assert.equal(synced.status, "ready", JSON.stringify(synced.last_run));
    assert.equal(synced.stats.items, 2);
    assert.deepEqual(calls[0], { tool: "WEBSITE_CRAWL", args: { url: "https://a.dev/" } }); // no depth: the crawl's default
    synced = await sources.sync({ id: source.id, budgetMs: 10_000 });
    assert.equal(synced.last_run.updated, 1);
    assert.equal(synced.last_run.removed, 1); // a page that is gone from a whole crawl is dropped
  });

  it("W2 a crawl cut short by time keeps the pages it did not reach", async () => {
    const { sources } = siteSources([
      { successful: true, data: { complete: true, pages: [pageOf("https://a.dev/", "home"), pageOf("https://a.dev/b", "bee")] } },
      { successful: true, data: { complete: false, pages: [pageOf("https://a.dev/", "home")] } },
    ]);
    const source = await sources.create({ template: "website", scope: { url: "https://a.dev/", depth: "1" } });
    await sources.sync({ id: source.id, budgetMs: 10_000 });
    const synced = await sources.sync({ id: source.id, budgetMs: 10_000 });
    assert.equal(synced.last_run.removed, 0);
    assert.equal(synced.stats.items, 2);
  });

  it("W3 HTML as text: headings and lists kept, scripts, navigation and footers dropped, links found", () => {
    const page = htmlText(`<html><head><title>Docs &amp; guides</title><script>x()</script></head><body>
      <nav><a href="/menu">Menu</a></nav><h1>Start</h1><p>Install it&nbsp;now.</p><ul><li>One</li><li>Two</li></ul>
      <a href='/guide/next'>Next</a><footer>© us</footer></body></html>`);
    assert.equal(page.title, "Docs & guides");
    assert.match(page.text, /^# Start\n\nInstall it now\.\n\n?- One\n- Two/);
    assert.doesNotMatch(page.text, /x\(\)|Menu|© us/);
    assert.deepEqual(page.links, ["/menu", "/guide/next"]);
  });

  it("W4 addresses: https added to a bare host, private networks refused", () => {
    assert.equal(siteUrl("docs.example.com"), "https://docs.example.com/");
    assert.throws(() => siteUrl("intranet"), /not a website/);
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.5", "::1", "fd00::1", "::ffff:7f00:1"]) assert.ok(privateAddress(ip), ip);
    for (const ip of ["8.8.8.8", "104.20.23.154", "2606:4700::1"]) assert.ok(!privateAddress(ip), ip);
  });
});

describe("MCP servers by address", () => {
  it("M1 one address, one toolkit slug, whatever way it is written", () => {
    assert.equal(mcpUrl("https://MCP.Linear.app/mcp/#x"), "https://mcp.linear.app/mcp");
    assert.equal(mcpSlug(mcpUrl("https://mcp.linear.app/mcp/")), mcpSlug("https://mcp.linear.app/mcp"));
    assert.match(mcpSlug("https://mcp.linear.app/mcp"), /^MCP_LINEAR_[0-9A-F]{8}$/);
    assert.match(mcpSlug("https://gateway.pipeworx.io/wikipedia/mcp"), /^MCP_PIPEWORX_WIKIPEDI_[0-9A-F]{8}$/);
    assert.ok(mcpSlug("https://a-very-long-company-name.example.com/and-a-long-path/mcp").length <= 30);
    assert.match(mcpSlug("https://api.example.com/v1/sse"), /^MCP_EXAMPLE_[0-9A-F]{8}$/);
    assert.notEqual(mcpSlug("https://mcp.linear.app/mcp"), mcpSlug("https://mcp.linear.app/sse"));
    assert.throws(() => mcpUrl("http://mcp.example.com"), /https/);
  });
});
