#!/usr/bin/env node
// Usage: genter <tool> '<json args>'     e.g. genter search '{"query":"latest emails"}'
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent.js";
import { createGenter } from "../src/genter.js";
import { agentResultText, agentTools, tools } from "../src/tools.js";

const dir = join(homedir(), ".genter");
const read = (file) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : {});
const write = (file, data) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
};

// Local store: encrypted recipes in ~/.genter/calls.json, agent runs in ~/.genter/runs.json.
const store = {
  get: async (id) => read("calls.json")[id],
  put: async (row) => write("calls.json", { ...read("calls.json"), [row.id]: row }),
  all: async () => Object.values(read("calls.json")).filter((r) => r.remembered),
};
// Sources: ~/.genter/sources.json (one encrypted row per source) and ~/.genter/knowledge.json (per item).
const knowledge = {
  getSource: async (id) => read("sources.json")[id],
  putSource: async (row) => write("sources.json", { ...read("sources.json"), [row.id]: row }),
  deleteSource: async (id) => {
    const all = read("sources.json");
    delete all[id];
    write("sources.json", all);
  },
  sources: async () => Object.values(read("sources.json")),
  items: async (sourceId) => Object.values(read("knowledge.json")).filter((r) => r.source_id === sourceId),
  putItems: async (rows) => write("knowledge.json", { ...read("knowledge.json"), ...Object.fromEntries(rows.map((r) => [`${r.source_id}:${r.key}`, r])) }),
  deleteItems: async (sourceId, keys) => {
    const all = read("knowledge.json");
    for (const key of keys) delete all[`${sourceId}:${key}`];
    write("knowledge.json", all);
  },
  allItems: async () => Object.values(read("knowledge.json")),
};
const runs = {
  get: async (id) => read("runs.json")[id],
  put: async (row) => write("runs.json", { ...read("runs.json"), [row.id]: row }),
};

// Agent commands: the same agent the MCP server runs (GENTER_RUN_TASK, GENTER_FIND, GENTER_CONTINUE_TASK).
const agentCommands = {
  run: { tool: "GENTER_RUN_TASK", start: (agent, { task, account }) => agent.start({ task, account }) },
  find: { tool: "GENTER_FIND", start: (agent, { question, account }) => agent.start({ task: question, mode: "find", account }) },
  continue: { tool: "GENTER_CONTINUE_TASK", start: (agent, args) => agent.send(args) },
};

const [name, json = "{}"] = process.argv.slice(2);
if (!tools[name] && !agentCommands[name]) {
  console.log("genter <command> '<json args>'\n");
  console.log(`  ${"run".padEnd(14)} {task, account?}: an agent does the task in your apps, recipes first`);
  console.log(`  ${"find".padEnd(14)} {question, account?}: read-only agent, answers from past results and live data`);
  console.log(`  ${"continue".padEnd(14)} {run_id, message}: answer a run's question or give a follow-up\n`);
  for (const [tool, { description }] of Object.entries(tools)) console.log(`  ${tool.padEnd(14)} ${description}`);
  console.log(`\nKeys: genter login '{"composio_api_key":"...","openrouter_api_key":"...","user_id":"me"}'`);
  console.log("or env COMPOSIO_API_KEY, OPENROUTER_API_KEY, GENTER_USER_ID");
  process.exit(name ? 1 : 0);
}

try {
  let args = JSON.parse(json);
  if (name === "login") {
    // login also saves keys passed to it
    const { composio_api_key, openrouter_api_key, user_id, ...rest } = args;
    write("config.json", { ...read("config.json"), ...JSON.parse(JSON.stringify({ composio_api_key, openrouter_api_key, user_id })) });
    args = rest;
  }
  let config = read("config.json");
  if (!config.secret) write("config.json", (config = { ...config, secret: randomBytes(32).toString("base64") }));
  const genter = createGenter({
    composioApiKey: process.env.COMPOSIO_API_KEY || config.composio_api_key,
    openrouterApiKey: process.env.OPENROUTER_API_KEY || config.openrouter_api_key,
    userId: process.env.GENTER_USER_ID || config.user_id || "default",
    secret: config.secret,
    store,
    knowledge,
  });
  const sourceCommands = {
    sources: () => genter.sources.list(),
    add_source: (input) => genter.sources.create(input),
    sync_source: ({ id, budget_ms }) => genter.sources.sync({ id, budgetMs: budget_ms }),
    remove_source: (input) => genter.sources.remove(input),
  };
  if (agentCommands[name]) {
    const { tool, start } = agentCommands[name];
    const input = agentTools()[tool].input.parse(args);
    const agent = createAgent({
      genter,
      openrouterApiKey: process.env.OPENROUTER_API_KEY || config.openrouter_api_key,
      secret: config.secret,
      userId: process.env.GENTER_USER_ID || config.user_id || "default",
      runs,
      onEvent: (e) => e.type === "step" && console.error(`· ${e.tool}`),
    });
    console.log(agentResultText(await start(agent, input)));
  } else {
    const input = tools[name].input.parse(args);
    const res = await (sourceCommands[name] ?? genter[name])(input);
    const out = Array.isArray(res) ? res : (({ pending, ...rest }) => rest)(res);
    console.log(JSON.stringify(out, null, 2));
  }
  await genter.flush(); // recipes are saved after the result is shown
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
