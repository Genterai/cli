// The commands that need no keys and no packages: folders, files, websites and notes (src/local.js), and the same as an
// MCP server over stdio (src/mcp-server.js).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_URL, TOKENS_PAGE, cloudFind, cloudOf, cloudText, whoami } from "../src/cloud.js";
import { runDemo } from "../src/demo.js";
import { createLocal, embedderFor, embeddingProvider, findText, genterHome } from "../src/local.js";
import { serveMcp } from "../src/mcp-server.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `genter ${version}: resolver for AI agents. A question resolves to where its answer is written, and Genter
reads it there again, so the answer is what your docs say now.

  genter demo                        see it in a second, on a temp folder
  genter ask <question>              the passages that answer, read now, with path:lines (the current folder at first)
  genter add <folder|file|url> ...   search these from now on
  genter remember <text>             keep a note (~/.genter/notes.md); ask finds it with its date
  genter sources                     what ask searches
  genter forget <folder|file|url>    stop searching it
  genter mcp [folder|url ...]        all of it for your agent (MCP over stdio):
                                     claude mcp add genter -- npx -y genter-cli mcp
  genter login <token>               also find in your apps through Genter Cloud (a token from ${TOKENS_PAGE})
  genter logout

  --json             JSON
  --limit N          passages (default 5)
  --semantic         also rank by meaning (any language): OPENAI_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY,
                     Ollama on this computer, or GENTER_EMBED_URL; --provider openai|openrouter|vercel|ollama picks one
  --local, --cloud   signed in: only this computer, or only your apps

Your apps on your own Composio keys (two packages: npm i -g @composio/core zod):
  genter run | find | continue | write | register_tool | search | execute | anchors '<json>'
  genter login '{"composio_api_key":"...","openrouter_api_key":"...","user_id":"me"}'

Genter Cloud does this for a team, across 500+ apps, kept current by their events: ${CLOUD_URL}`;

function parse(argv) {
  const flags = { json: false, semantic: false, local: false, cloud: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--semantic") flags.semantic = true;
    else if (a === "--local") flags.local = true;
    else if (a === "--cloud") flags.cloud = true;
    else if (a === "--provider") flags.provider = argv[++i];
    else if (a.startsWith("--provider=")) flags.provider = a.slice(11);
    else if (a === "--limit" || a === "--depth") flags[a.slice(2)] = Number(argv[++i]);
    else if (a.startsWith("--limit=") || a.startsWith("--depth=")) flags[a.slice(2, 7)] = Number(a.slice(8));
    else words.push(a);
  }
  return { flags, words };
}

function config(home) {
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

// config.json holds the store's secret, keys and the cloud token: only its owner reads it.
function saveConfig(home, config) {
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.json");
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

const say = (flags, data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

export async function local(argv) {
  const [command = "help", ...rest] = argv;
  const { flags, words } = parse(rest);
  if (command === "--version" || command === "-v") return console.log(version);
  if (["help", "--help", "-h"].includes(command)) return console.log(HELP);
  if (command === "demo") return runDemo();
  if (!["add", "ask", "remember", "forget", "sources", "mcp", "login", "logout"].includes(command)) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  try {
    const home = genterHome();
    const c = config(home);
    if (command === "login") return await login(home, c, words[0], flags);
    if (command === "logout") {
      const { cloud, ...rest } = c;
      saveConfig(home, rest);
      return say(flags, { signed_out: Boolean(cloud) }, cloud ? `Signed out of ${cloud.workspace ?? cloud.url}.${process.env.GENTER_TOKEN ? " GENTER_TOKEN is still set." : ""}` : "Not signed in.");
    }
    const semantic = flags.semantic || Boolean(flags.provider) || process.env.GENTER_SEMANTIC === "1" || c.semantic === true;
    const embed = semantic ? embedderFor(embeddingProvider({ env: process.env, config: c, name: flags.provider })) : undefined;
    const cloud = flags.local ? null : cloudOf({ env: process.env, config: c });
    if (flags.cloud && !cloud) throw new Error(`--cloud finds in your apps through Genter Cloud: genter login <token from ${TOKENS_PAGE}>`);
    const g = createLocal({ home, userId: process.env.GENTER_USER_ID || c.user_id || "default", embed });

    if (command === "add") {
      if (!words.length) throw new Error("genter add <folder|file|url> ...");
      for (const target of words) {
        const out = await g.add(target, { depth: flags.depth });
        say(flags, out, `${out.new ? "Added" : "Read again"} ${out.source.place}: ${out.places} ${out.source.kind === "website" ? "pages" : "files"} (${out.created} new, ${out.changed} changed, ${out.gone} gone)${out.complete === false ? ", the listing stopped at its limit" : ""}`);
      }
    } else if (command === "ask") {
      const question = words.join(" ");
      if (!question.trim()) throw new Error('genter ask "<question>"');
      // Your apps (signed in) are asked at the same time; this computer's passages come first, at once.
      const remote = cloud ? cloudFind(cloud, question).then((found) => ({ found }), (error) => ({ error })) : null;
      let out = null;
      if (!flags.cloud) {
        out = await g.find(question, { limit: flags.limit });
        if (out.added) console.error(`(searching ${out.added.source.place}, added as a source: genter forget ${out.added.source.place} to stop)`);
        if (semantic && out.semantic !== true) console.error(`(ranking by meaning ${out.semantic || "off"})`);
        if (!flags.json) console.log(findText(out));
      }
      if (remote) {
        if (!flags.json) console.error(`${out ? "\n" : ""}(finding in your apps · Genter Cloud${cloud.workspace ? ` (${cloud.workspace})` : ""}…)`);
        const { found, error } = await remote;
        if (error) {
          console.error(error.message);
          if (flags.cloud) process.exitCode = 1;
        } else if (!flags.json) console.log(`\n${cloudText(found, cloud)}`);
        if (flags.json) console.log(JSON.stringify({ ...(out ?? {}), cloud: error ? { error: error.message } : found }, null, 2));
      } else if (flags.json) console.log(JSON.stringify(out, null, 2));
    } else if (command === "remember") {
      const out = g.remember(words.join(" "));
      say(flags, out, `Kept in ${out.path}`);
    } else if (command === "forget") {
      if (!words[0]) throw new Error("genter forget <folder|file|url>");
      const out = g.forget(words[0]);
      say(flags, out, `Forgot ${out.source.place} (${out.removed} anchors)`);
    } else if (command === "sources") {
      const list = g.sources();
      say(flags, list, list.length ? list.map((s) => `${s.kind.padEnd(8)} ${s.place}  ${s.places} places${s.gone ? `, ${s.gone} gone` : ""}`).join("\n") : "Nothing yet: genter add <folder|file|url>");
    } else if (command === "mcp") {
      for (const target of words) {
        const out = await g.add(target, { depth: flags.depth });
        console.error(`genter: ${out.source.place}, ${out.places} places`);
      }
      if (cloud) console.error(`genter: also finding in your apps · Genter Cloud${cloud.workspace ? ` (${cloud.workspace})` : ""}`);
      await serveMcp(g, { version, cloud });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// genter login <gnt_ token>: checks it with Genter Cloud and keeps it; with no token, says where things stand.
async function login(home, c, token, flags) {
  if (!token) {
    const cloud = cloudOf({ env: process.env, config: c });
    if (!cloud) return say(flags, { signed_in: false }, `Not signed in. Make a token in ${TOKENS_PAGE} (API tokens), then:\n  genter login gnt_...\nThen genter ask and genter mcp also find in your apps: mail, calendar, GitHub, Slack, Notion and 500 more.`);
    const me = await whoami(cloud);
    return say(flags, { signed_in: true, ...me, url: cloud.url }, `Signed in to ${me.workspace} as ${me.user} (${cloud.url}). genter logout to sign out.`);
  }
  const url = (process.env.GENTER_URL || CLOUD_URL).replace(/\/+$/, "");
  const me = await whoami({ token, url });
  saveConfig(home, { ...c, cloud: { token, url, workspace: me.workspace, user: me.user } });
  say(flags, { signed_in: true, ...me, url }, `Signed in to ${me.workspace} as ${me.user}.\ngenter ask and genter mcp now also find in that workspace's apps; it uses its credits, and --local skips it.`);
}
