import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cloudOf, whoami } from "../src/cloud.js";
import { createLocal, embedderFor, embeddingProvider } from "../src/local.js";
import { handle } from "../src/mcp-server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = `gnt_${"a".repeat(43)}`;

// A stand-in for Genter Cloud: /api/v1/me knows TOKEN, /api/v1/cli/find answers from "the apps".
async function fakeCloud({ find = () => ({ status: 200, body: { result: { text: "Anna wrote on Monday: the contract is signed [1].", references: [{ n: 1 }] } } }) } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
      const send = (status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "Invalid, expired or revoked API token", code: "invalid_token" });
      if (req.url === "/api/v1/me") return send(200, { user: { email: "anna@acme.test" }, ws: { name: "Acme" }, credits: { plan: "pro", name: "Pro" } });
      if (req.url === "/api/v1/cli/find") {
        const { status, body: out } = find(JSON.parse(body));
        return send(status, out);
      }
      send(404, { error: "no" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

// The package as installed, run as a command with its own home and env.
function installed() {
  const base = mkdtempSync(join(tmpdir(), "genter-cloud-"));
  for (const part of ["bin", "src", "package.json"]) cpSync(join(root, part), join(base, "pkg", part), { recursive: true });
  mkdirSync(join(base, "project/docs"), { recursive: true });
  writeFileSync(join(base, "project/docs/deploy.md"), "# Deploy\n\nProduction ships on Thursday.\n");
  const home = join(base, "home/.genter");
  const run = (args, env = {}) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(base, "pkg/bin/genter.js"), ...args], { cwd: join(base, "project"), env: { PATH: process.env.PATH, HOME: join(base, "home"), GENTER_HOME: home, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  return { run, home, done: () => rmSync(base, { recursive: true, force: true }) };
}

describe("genter login and Genter Cloud", () => {
  it("[spec:cli/cloud-login] [spec:cli/cloud-ask] keeps a checked token, and ask adds the cloud's answer after the local passages", async () => {
    const cloud = await fakeCloud();
    const pkg = installed();
    try {
      const env = { GENTER_URL: cloud.url };
      const bad = await pkg.run(["login", "gnt_wrongwrongwrongwrongwrong"], env);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /token was refused/);
      const ok = await pkg.run(["login", TOKEN], env);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /Signed in to Acme as anna@acme\.test/);
      const config = JSON.parse(readFileSync(join(pkg.home, "config.json"), "utf8"));
      assert.deepEqual(config.cloud, { token: TOKEN, url: cloud.url, workspace: "Acme", user: "anna@acme.test" });
      assert.equal(statSync(join(pkg.home, "config.json")).mode & 0o777, 0o600);

      const asked = await pkg.run(["ask", "when", "does", "production", "ship?"]);
      assert.equal(asked.status, 0, asked.stderr);
      assert.match(asked.stdout, /^\[1\] docs\/deploy\.md:1-3/m);
      assert.match(asked.stdout, /From your apps · Genter Cloud \(Acme\):\n\nAnna wrote on Monday/);
      assert.ok(asked.stdout.indexOf("docs/deploy.md") < asked.stdout.indexOf("Genter Cloud"));
      assert.deepEqual(cloud.seen.at(-1), { method: "POST", url: "/api/v1/cli/find", auth: `Bearer ${TOKEN}`, body: { question: "when does production ship?" } });

      const local = await pkg.run(["ask", "production", "--local"]);
      assert.doesNotMatch(local.stdout, /Genter Cloud/);
      const only = await pkg.run(["ask", "contract", "--cloud", "--json"]);
      assert.deepEqual(JSON.parse(only.stdout).cloud.text, "Anna wrote on Monday: the contract is signed [1].");

      const status = await pkg.run(["login"]);
      assert.match(status.stdout, /Signed in to Acme/);
      const out = await pkg.run(["logout"]);
      assert.match(out.stdout, /Signed out of Acme/);
      assert.match((await pkg.run(["login"])).stdout, /Not signed in\. Make a token in https:\/\/genter\.ai\/dashboard\/settings/);
      assert.equal((await pkg.run(["ask", "x", "--cloud"])).status, 1);
    } finally {
      cloud.close();
      pkg.done();
    }
  });

  it("[spec:cli/cloud-fail-local] still prints the local passages when the cloud refuses", async () => {
    const cloud = await fakeCloud({ find: () => ({ status: 402, body: { error: "Today's 20 credits are used up", code: "daily_limit" } }) });
    const pkg = installed();
    try {
      const out = await pkg.run(["ask", "production"], { GENTER_URL: cloud.url, GENTER_TOKEN: TOKEN });
      assert.equal(out.status, 0);
      assert.match(out.stdout, /docs\/deploy\.md/);
      assert.match(out.stderr, /Genter Cloud: Today's 20 credits are used up/);
    } finally {
      cloud.close();
      pkg.done();
    }
  });

  it("[spec:cli/cloud-env] GENTER_TOKEN and GENTER_URL sign in without the config", async () => {
    assert.equal(cloudOf({ env: {}, config: {} }), null);
    assert.deepEqual(cloudOf({ env: { GENTER_TOKEN: TOKEN, GENTER_URL: "http://x/" }, config: {} }), { token: TOKEN, url: "http://x", workspace: null });
    assert.deepEqual(cloudOf({ env: {}, config: { cloud: { token: TOKEN, workspace: "Acme" } } }), { token: TOKEN, url: "https://genter.ai", workspace: "Acme" });
    await assert.rejects(whoami({ token: "sk-not-genter", url: "http://127.0.0.1:9" }), /starts with gnt_/);
  });

  it("[spec:cli/local-mcp-cloud] the MCP server's genter_find adds the cloud's answer when signed in", async () => {
    const cloud = await fakeCloud();
    const base = mkdtempSync(join(tmpdir(), "genter-mcp-cloud-"));
    try {
      mkdirSync(join(base, "p"));
      writeFileSync(join(base, "p/a.md"), "# A\n\nThe contract folder is on the drive.\n");
      const local = createLocal({ home: join(base, "h"), secret: "s", cwd: join(base, "p") });
      const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "genter_find", arguments: { question: "contract" } } };
      const out = await handle(local, msg, { cloud: { token: TOKEN, url: cloud.url, workspace: "Acme" } });
      assert.match(out.result.content[0].text, /a\.md[\s\S]*From your apps · Genter Cloud \(Acme\)/);
      const list = await handle(local, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { cloud: { token: TOKEN, url: cloud.url } });
      assert.match(list.result.tools[0].description, /Genter Cloud workspace/);
    } finally {
      cloud.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("embedding providers", () => {
  it("[spec:local-search/semantic-providers] picks the endpoint, the named one, the first key set, else Ollama", () => {
    assert.deepEqual(embeddingProvider({ env: { GENTER_EMBED_URL: "http://lm:1234/v1/", GENTER_EMBED_MODEL: "bge" } }), { name: "custom", url: "http://lm:1234/v1", key: undefined, model: "bge" });
    assert.equal(embeddingProvider({ env: { OPENROUTER_API_KEY: "r", OPENAI_API_KEY: "o" } }).name, "openai");
    assert.deepEqual(embeddingProvider({ env: { AI_GATEWAY_API_KEY: "v" } }), { name: "vercel", url: "https://ai-gateway.vercel.sh/v1", key: "v", model: "openai/text-embedding-3-small" });
    assert.equal(embeddingProvider({ env: { AI_GATEWAY_TOKEN: "t" } }).key, "t");
    assert.equal(embeddingProvider({ env: { OPENAI_API_KEY: "o" }, name: "ollama" }).url, "http://localhost:11434/v1");
    assert.equal(embeddingProvider({ env: {}, config: { openrouter_api_key: "r" } }).name, "openrouter");
    assert.equal(embeddingProvider({ env: {} }).name, "ollama");
    assert.throws(() => embeddingProvider({ env: {}, name: "openai" }), /openai needs OPENAI_API_KEY/);
    assert.throws(() => embeddingProvider({ env: {}, name: "nope" }), /Unknown provider/);
  });

  it("[spec:local-search/semantic-providers] calls any OpenAI-compatible /embeddings and says how to get one when none answers", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      if (String(url).startsWith("http://localhost:11434")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [index, 1] })) }), { status: 200 });
    };
    try {
      const embed = embedderFor({ name: "vercel", url: "https://ai-gateway.vercel.sh/v1", key: "v", model: "openai/text-embedding-3-small" });
      assert.deepEqual(await embed(["a", "b"]), [[0, 1], [1, 1]]);
      assert.deepEqual(calls[0], { url: "https://ai-gateway.vercel.sh/v1/embeddings", auth: "Bearer v", body: { model: "openai/text-embedding-3-small", input: ["a", "b"] } });
      assert.equal(embed.model, "openai/text-embedding-3-small");
      await assert.rejects(embedderFor(embeddingProvider({ env: {} }))(["x"]), /No embeddings: set OPENAI_API_KEY.*Ollama.*ECONNREFUSED/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("genter demo", () => {
  it("[spec:cli/demo] shows a changed answer and a replaced doc on a temp folder, with no key", async () => {
    const pkg = installed();
    try {
      const out = await pkg.run(["demo"]);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /port 6432[\s\S]*Since the last look: docs\/deploy\.md changed[\s\S]*changed since the last look[\s\S]*port 5433/);
      assert.match(out.stdout, /still answers:\n {2}"Staging deploys every Tuesday from `main`\. The pooler listens on port 6432\."/);
      assert.match(out.stdout, /\[2\] docs\/runbook-v2\.md:3-5 · Runbook v2 › Restarting the probes\n {6}replaces \[1\]/);
    } finally {
      pkg.done();
    }
  });
});
