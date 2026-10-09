#!/usr/bin/env node
// No keys, no packages:  genter add ./docs   ·   genter ask "how do we deploy?"   ·   genter mcp
// Your apps (Composio):  genter <command> '<json args>'     e.g. genter search '{"query":"latest emails"}'
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL = new Set(["add", "ask", "remember", "forget", "sources", "mcp", "demo", "logout", "help", "--help", "-h", "--version", "-v"]);
const APPS = new Set(["run", "find", "continue", "write", "register_tool", "login", "search", "execute", "recipes", "anchors", "recheck_recipe", "recheck_anchor", "remove_recipe", "remove_anchor"]);
const first = process.argv[2];
// `genter login <token>` (or alone) signs in to Genter Cloud; `genter login '{...}'` keeps the app commands' keys.
const cloudLogin = first === "login" && !String(process.argv[3] ?? "").trim().startsWith("{");
if (!first || LOCAL.has(first) || cloudLogin || !APPS.has(first)) {
  const { local } = await import("./local.js");
  await local(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}

// The app commands need @composio/core and zod (optional peers: npm i -g @composio/core zod).
let createAgent;
let createGenter;
let agentResultText;
let agentTools;
let tools;
try {
  ({ createAgent } = await import("../src/agent.js"));
  ({ createGenter } = await import("../src/genter.js"));
  ({ agentResultText, agentTools, tools } = await import("../src/tools.js"));
} catch (e) {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
  console.error(`genter ${first} works in your apps through Composio and needs two packages: npm i -g @composio/core zod\n(${e.message.split("\n")[0]})\n\nWith no keys and no packages: genter add <folder|file|url>, genter ask <question>, genter mcp. See genter help.`);
  process.exit(1);
}

process.env.GENTER_COST_LOG ??= "0"; // cost events are for servers (stdout -> log drain); a terminal stays quiet unless asked

const dir = process.env.GENTER_HOME || join(homedir(), ".genter");
const read = (file) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : {});
const write = (file, data) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
};

// Local store: encrypted anchors in ~/.genter/calls.json, agent runs in ~/.genter/runs.json.
const store = {
  get: async (id) => read("calls.json")[id],
  put: async (row) => write("calls.json", { ...read("calls.json"), [row.id]: row }),
  all: async () => Object.values(read("calls.json")).filter((r) => r.remembered),
  remove: async (id) => {
    const all = read("calls.json");
    delete all[id];
    write("calls.json", all);
  },
};
const runs = {
  get: async (id) => read("runs.json")[id],
  put: async (row) => write("runs.json", { ...read("runs.json"), [row.id]: row }),
};

// Agent commands: the same agent the MCP server runs (GENTER_RUN_TASK, GENTER_FIND, GENTER_CONTINUE_TASK, GENTER_WRITE).
const agentCommands = {
  run: { tool: "GENTER_RUN_TASK", start: (agent, { task, account }) => agent.start({ task, account }) },
  find: { tool: "GENTER_FIND", start: (agent, { question, account }) => agent.start({ task: question, mode: "find", account }) },
  continue: { tool: "GENTER_CONTINUE_TASK", start: (agent, args) => agent.send(args) },
  write: { tool: "GENTER_WRITE", start: (agent, args) => agent.write(args) },
};

// Anchors were called recipes: the anchor names are aliases of the recipe commands (both work).
const aliases = { anchors: "recipes", recheck_anchor: "recheck_recipe", remove_anchor: "remove_recipe" };
const [given, json = "{}"] = process.argv.slice(2);
const name = aliases[given] ?? given;
if (!tools[name] && !agentCommands[name]) {
  console.log("genter <command> '<json args>': your apps through Composio (genter help: the commands with no keys)\n");
  console.log(`  ${"run".padEnd(14)} {task, account?}: an agent does the task in your apps, anchors first`);
  console.log(`  ${"find".padEnd(14)} {question, account?}: read-only agent, answers from past results and live data`);
  console.log(`  ${"continue".padEnd(14)} {run_id, message}: answer a run's question or give a follow-up`);
  console.log(`  ${"write".padEnd(14)} {run_id, ref, change}, {run_id, ref, edits, message} (a file) or {run_id, ref, tool, args}: write where a reference [n] (or a link) points\n`);
  for (const [tool, { description }] of Object.entries(tools)) console.log(`  ${tool.padEnd(14)} ${description}`);
  console.log(`\nAliases: ${Object.entries(aliases).map(([alias, command]) => `${alias} = ${command}`).join(", ")}`);
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
  });
  // Commands that are not plain genter methods.
  const recipeCommands = {
    recipes: () => genter.recipes.list(),
    recheck_recipe: ({ id }) => genter.recipes.recheck(id),
    remove_recipe: ({ id }) => genter.recipes.remove(id),
  };
  if (agentCommands[name]) {
    const { tool, start } = agentCommands[name];
    const input = agentTools({ actions: true })[tool].input.parse(args);
    const agent = createAgent({
      genter,
      openrouterApiKey: process.env.OPENROUTER_API_KEY || config.openrouter_api_key,
      secret: config.secret,
      userId: process.env.GENTER_USER_ID || config.user_id || "default",
      runs,
      onEvent: (e) => e.type === "step" && console.error(`· ${e.tool}`),
    });
    console.log(agentResultText(await start(agent, input), { write: true }));
  } else {
    const input = tools[name].input.parse(args);
    const res = await (recipeCommands[name] ?? genter[name])(input);
    const out = Array.isArray(res) ? res : (({ pending, ...rest }) => rest)(res);
    console.log(JSON.stringify(out, null, 2));
  }
  await genter.flush(); // anchors are saved after the result is shown
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
