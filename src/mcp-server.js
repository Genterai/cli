import { createInterface } from "node:readline";
import { findText } from "./local.js";

// The local engine as an MCP server over stdio (JSON-RPC, one message per line), with no package: `genter mcp`.
// Claude Code: claude mcp add genter -- npx -y github:Genterai/genter-cli mcp

export const instructions = `Genter searches the person's folders, files, websites and notes where they are and reads them again on every search: what it returns is what they say now, with where it is (path:lines or a link) and what changed since the last look.
Genter finds; you think and write. It never writes an answer, and it changes nothing but its notes file.
- genter_find: before answering a question about the person's project, docs, decisions, people or preferences. Cite the places it returns. When two places disagree, say so and prefer the one that changed last or that marks the other as replaced.
- genter_remember: when the person tells you something to keep (a decision, a preference, a fact about them or the work). One fact per note, in their words.
- genter_add: when the person points you at a folder, a file or a public website to keep searching.`;

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const mcpTools = [
  {
    name: "genter_find",
    description: "Finds where the answer is written in the person's folders, files, websites and notes, reads those places again now and returns the passages under the line that says where each is (path:lines or a link), with what changed since the last look. Read-only. Ask in the person's words.",
    inputSchema: { type: "object", properties: { question: { type: "string", description: "What to find, in the person's words" }, limit: { type: "integer", minimum: 1, maximum: 20, description: "Passages at most (default 5)" } }, required: ["question"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "genter_remember",
    description: "Keeps a note in the person's notes file (a heading with the time, then the text); genter_find finds it later with its date. For a decision, a preference or a fact the person wants kept.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The note, one fact, in the person's words" } }, required: ["text"] },
  },
  {
    name: "genter_add",
    description: "Adds a folder, a file or a public website to what genter_find searches; every file or page is read now.",
    inputSchema: { type: "object", properties: { source: { type: "string", description: "A path (absolute, or relative to where the server runs) or an https:// address" }, depth: { type: "integer", minimum: 0, maximum: 2, description: "Websites: links to follow from the address (default 2)" } }, required: ["source"] },
  },
  {
    name: "genter_sources",
    description: "Lists what genter_find searches: folders, files, websites and the notes file.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

// Runs one tool: { text, isError? }.
export async function callTool(local, name, args = {}) {
  switch (name) {
    case "genter_find":
      return { text: findText(await local.find(args.question, { limit: args.limit })) };
    case "genter_remember": {
      const out = local.remember(args.text);
      return { text: `Kept in ${out.path} (${out.at}).` };
    }
    case "genter_add": {
      const out = await local.add(args.source, { depth: args.depth });
      return { text: `${out.new ? "Added" : "Read again"} ${out.source.place}: ${out.places} places (${out.created} new, ${out.changed} changed, ${out.gone} gone)${out.complete === false ? "; the listing stopped at its limit" : ""}.` };
    }
    case "genter_sources": {
      const list = local.sources();
      return { text: list.length ? list.map((s) => `${s.kind} ${s.place}: ${s.places} places${s.gone ? `, ${s.gone} gone` : ""}`).join("\n") : "Nothing yet: genter_add a folder, a file or a website." };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// Answers one JSON-RPC message; null for a notification.
export async function handle(local, msg, { version = "0.0.0" } = {}) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  const notification = msg.id === undefined || msg.id === null;
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "genter", version }, instructions });
      }
      case "ping":
        return notification ? null : reply({});
      case "tools/list":
        return reply({ tools: mcpTools });
      case "tools/call": {
        const { name, arguments: args } = msg.params ?? {};
        try {
          const { text } = await callTool(local, name, args ?? {});
          return reply({ content: [{ type: "text", text }] });
        } catch (e) {
          if (e.code === -32602) return fail(-32602, e.message);
          return reply({ content: [{ type: "text", text: e.message }], isError: true });
        }
      }
      default:
        if (notification) return null; // notifications/initialized, notifications/cancelled, …
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    return notification ? null : fail(-32603, e.message);
  }
}

// Serves until stdin ends. Logs go to stderr: stdout carries only the protocol.
export function serveMcp(local, { input = process.stdin, output = process.stdout, version } = {}) {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const write = (m) => m && output.write(`${JSON.stringify(m)}\n`);
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    // One at a time, answers in the order of the questions: the store is one file.
    queue = queue.then(() => (msg ? handle(local, msg, { version }) : { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })).then(write);
  });
  return new Promise((done) => lines.on("close", () => queue.then(done)));
}
