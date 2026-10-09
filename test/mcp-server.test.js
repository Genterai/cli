import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createLocal } from "../src/local.js";
import { handle, serveMcp } from "../src/mcp-server.js";

function project() {
  const base = mkdtempSync(join(tmpdir(), "genter-mcp-"));
  mkdirSync(join(base, "project/docs"), { recursive: true });
  writeFileSync(join(base, "project/docs/deploy.md"), "# Deploy\n\n## Production\n\nProduction ships on Thursday after the change review.\n");
  const local = createLocal({ home: join(base, "home"), secret: "s", cwd: join(base, "project") });
  return { local, done: () => rmSync(base, { recursive: true, force: true }) };
}
const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params && { params }) });

describe("the local MCP server", () => {
  it("[spec:cli/ac-mcp-tools] [spec:cli/local-mcp-tools] answers initialize and lists the four local tools", async () => {
    const p = project();
    try {
      const init = await handle(p.local, rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }), { version: "9.9.9" });
      assert.equal(init.result.protocolVersion, "2025-06-18");
      assert.deepEqual(init.result.serverInfo, { name: "genter", version: "9.9.9" });
      assert.match(init.result.instructions, /Genter finds; you think and write/);
      const old = await handle(p.local, rpc(2, "initialize", { protocolVersion: "1999-01-01" }));
      assert.equal(old.result.protocolVersion, "2025-06-18");
      const list = await handle(p.local, rpc(3, "tools/list"));
      assert.deepEqual(list.result.tools.map((t) => t.name), ["genter_find", "genter_remember", "genter_add", "genter_sources"]);
      assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
    } finally {
      p.done();
    }
  });

  it("[spec:cli/local-mcp] finds, remembers and reports errors the MCP way", async () => {
    const p = project();
    try {
      const found = await handle(p.local, rpc(1, "tools/call", { name: "genter_find", arguments: { question: "which day does production ship?" } }));
      assert.match(found.result.content[0].text, /^\[1\] docs\/deploy\.md:3-5 · Deploy › Production/m);
      const kept = await handle(p.local, rpc(2, "tools/call", { name: "genter_remember", arguments: { text: "Freeze until Nov 1" } }));
      assert.match(kept.result.content[0].text, /^Kept in .*notes\.md/);
      const sources = await handle(p.local, rpc(3, "tools/call", { name: "genter_sources", arguments: {} }));
      assert.match(sources.result.content[0].text, /^folder /m);
      const empty = await handle(p.local, rpc(4, "tools/call", { name: "genter_find", arguments: { question: " " } }));
      assert.equal(empty.result.isError, true);
      assert.equal((await handle(p.local, rpc(5, "tools/call", { name: "nope" }))).error.code, -32602);
      assert.equal((await handle(p.local, rpc(6, "resources/list"))).error.code, -32601);
      assert.equal(await handle(p.local, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
      assert.equal((await handle(p.local, { id: 7 })).error.code, -32600);
    } finally {
      p.done();
    }
  });

  it("[spec:cli/local-mcp-stdout] speaks one JSON message per line on stdout, in order", async () => {
    const p = project();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = "";
      output.on("data", (d) => {
        text += d;
      });
      const served = serveMcp(p.local, { input, output, version: "1.0.0" });
      input.write(`${JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-03-26" }))}\n`);
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
      input.end(`${JSON.stringify(rpc(2, "tools/call", { name: "genter_find", arguments: { question: "production" } }))}\n`);
      await served;
      const lines = text.trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((m) => m.id), [1, null, 2]);
      assert.equal(lines[1].error.code, -32700);
      assert.match(lines[2].result.content[0].text, /Thursday/);
    } finally {
      p.done();
    }
  });
});
