#!/usr/bin/env node
// Usage: genter <tool> '<json args>'     e.g. genter search '{"query":"latest emails"}'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGenter } from "../src/genter.js";
import { tools } from "../src/tools.js";

const dir = join(homedir(), ".genter");
const read = (file) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : {});
const write = (file, data) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
};

// Local store: every call in ~/.genter/calls.json
const store = {
  get: async (id) => read("calls.json")[id],
  put: async (record) => write("calls.json", { ...read("calls.json"), [record.id]: record }),
  all: async () => Object.values(read("calls.json")),
};

const [name, json = "{}"] = process.argv.slice(2);
if (!tools[name]) {
  console.log("genter <tool> '<json args>'\n");
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
  const config = read("config.json");
  const genter = createGenter({
    composioApiKey: process.env.COMPOSIO_API_KEY || config.composio_api_key,
    openrouterApiKey: process.env.OPENROUTER_API_KEY || config.openrouter_api_key,
    userId: process.env.GENTER_USER_ID || config.user_id || "default",
    store,
  });
  const input = tools[name].input.parse(args);
  console.log(JSON.stringify(await genter[name](input), null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
