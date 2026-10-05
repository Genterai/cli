import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpSlug, mcpUrl } from "../src/mcp.js";
import { privateAddress } from "../src/net.js";
import { createGenter } from "../src/genter.js";
import { htmlText, siteUrl, underSite } from "../src/web.js";

// A site served over fetch (a public IP literal, so no DNS), OpenRouter answering every description, Composio nothing.
const SITE = "https://93.184.215.14/docs/";
function fakeWeb(pages) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("openrouter.ai/api/v1/embeddings")) return json({ data: [JSON.parse(init.body).input].flat().map((t, index) => ({ index, embedding: [1, t.length % 5, 0.5] })) });
    if (u.includes("openrouter.ai/api/v1/chat")) return json({ choices: [{ message: { content: JSON.stringify({ title: "A page", short: "A page.", summary: "A page of the docs.", items: [] }) } }] });
    if (u.startsWith("https://93.184.215.14/")) {
      const html = pages[new URL(u).pathname];
      return html == null ? new Response("no", { status: 404 }) : new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    return json({ items: [] }); // Composio: no tool info, no triggers
  };
  return () => (globalThis.fetch = original);
}
const memoryStore = () => {
  const rows = new Map();
  return { rows, get: async (id) => rows.get(id), put: async (row) => rows.set(row.id, row), all: async () => [...rows.values()].filter((r) => r.remembered), remove: async (id) => rows.delete(id) };
};
const memoryScopes = () => {
  const rows = new Map();
  return { rows, get: async (id) => rows.get(id), put: async (r) => rows.set(r.id, r), list: async () => [...rows.values()], remove: async (id) => rows.delete(id) };
};

describe("Websites", () => {
  it("W1 a site is a prepared area: each page a recipe; again, a changed page is described again and a removed one is gone", async () => {
    const pages = {
      "/docs/": `<title>Docs</title><h1>Docs</h1><p>Start here.</p><a href="a">A</a> <a href="/docs/b">B</a> <a href="/blog/x">out of the folder</a>`,
      "/docs/a": `<title>A</title><p>Install it.</p>`,
      "/docs/b": `<title>B</title><p>Configure it.</p>`,
    };
    const restore = fakeWeb(pages);
    try {
      const store = memoryStore();
      const scopes = memoryScopes();
      const deferred = [];
      const genter = createGenter({ composioApiKey: "k", openrouterApiKey: "o", userId: "w", secret: "s", store, scopes, defer: (p) => deferred.push(p) });
      let out = await genter.prepare_website({ url: SITE, account: "own_site" });
      await Promise.all(deferred.splice(0));
      assert.equal(out.pages, 3);
      assert.equal(out.created, 3);
      const list = await genter.recipes.list();
      assert.deepEqual(list.map((r) => r.args.url).sort(), [SITE, `${SITE}a`, `${SITE}b`]);
      assert.ok(list.every((r) => r.tool === "WEBSITE_READ_PAGE" && r.status === "fresh"));
      const [scope] = await scopes.list();
      assert.equal(scope.toolkit, "website");
      assert.equal(scope.spec.every, 60);

      pages["/docs/a"] = `<title>A</title><p>Install it with npm.</p>`;
      pages["/docs/"] = `<title>Docs</title><h1>Docs</h1><p>Start here.</p><a href="a">A</a>`;
      delete pages["/docs/b"];
      await new Promise((r) => setTimeout(r, 1)); // checked_at moves
      out = await genter.prepare_website({ url: SITE, account: "own_site" });
      await Promise.all(deferred.splice(0));
      assert.equal(out.changed, 2); // the start page lost its link to B, A has new text
      assert.equal(out.pages, 2);
      const status = Object.fromEntries((await genter.recipes.list()).map((r) => [r.args.url, r.status]));
      assert.equal(status[`${SITE}b`], "gone");

      const forgot = await genter.forget_website({ url: SITE, account: "own_site" });
      assert.equal(forgot.removed, 3);
      assert.equal((await genter.recipes.list()).length, 0);
      assert.equal((await scopes.list()).length, 0);
    } finally {
      restore();
    }
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
    assert.ok(underSite("https://www.docs.dev/guide/a", "docs.dev/guide/"));
    assert.ok(!underSite("https://docs.dev/blog/a", "docs.dev/guide/"));
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
