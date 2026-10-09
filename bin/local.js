// The commands that need no keys and no packages: folders, files, websites and notes (src/local.js), and the same as an
// MCP server over stdio (src/mcp-server.js).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocal, findText, genterHome } from "../src/local.js";
import { serveMcp } from "../src/mcp-server.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `genter ${version}: finds where the answer is written, and reads it again.

No keys, no packages:
  genter add <folder|file|url> ...   search it from now on: each file or page is read now and kept as an Anchor
  genter ask <question>              the passages that answer, read now, with path:lines, and what changed since the last look
  genter remember <text>             keep a note in ~/.genter/notes.md; ask finds it with its date
  genter sources                     what ask searches
  genter forget <folder|file|url>    stop searching it
  genter mcp [folder|url ...]        all of it as an MCP server (stdio):
                                     claude mcp add genter -- npx -y github:Genterai/genter-cli mcp

  With no source added yet, ask (and mcp) adds the current folder.
  --json prints JSON · --limit N passages (default 5) · --depth N links to follow on a website (0-2)
  --semantic also ranks by meaning with embeddings (OPENROUTER_API_KEY; the passages are sent to OpenRouter)

Your apps (Gmail, GitHub, Slack, Notion… through Composio; keys and two packages: npm i -g @composio/core zod):
  genter run | find | continue | write | login | register_tool | search | execute | anchors '<json>'
  genter login '{"composio_api_key":"...","openrouter_api_key":"...","user_id":"me"}'

The hosted Genter does this for a team across 500+ apps, keeps Anchors current on every change, and serves an MCP
address with sign-in: https://genter.ai`;

function parse(argv) {
  const flags = { json: false, semantic: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--semantic") flags.semantic = true;
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

const say = (flags, data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

export async function local(argv) {
  const [command = "help", ...rest] = argv;
  const { flags, words } = parse(rest);
  if (command === "--version" || command === "-v") return console.log(version);
  if (["help", "--help", "-h"].includes(command)) return console.log(HELP);
  if (!["add", "ask", "remember", "forget", "sources", "mcp"].includes(command)) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  try {
    const home = genterHome();
    const c = config(home);
    const semantic = flags.semantic || process.env.GENTER_SEMANTIC === "1" || c.semantic === true;
    const key = process.env.OPENROUTER_API_KEY || c.openrouter_api_key;
    if (semantic && !key) throw new Error("--semantic ranks with embeddings and needs an OpenRouter key: OPENROUTER_API_KEY");
    const g = createLocal({ home, userId: process.env.GENTER_USER_ID || c.user_id || "default", openrouterApiKey: semantic ? key : undefined });

    if (command === "add") {
      if (!words.length) throw new Error("genter add <folder|file|url> ...");
      for (const target of words) {
        const out = await g.add(target, { depth: flags.depth });
        say(flags, out, `${out.new ? "Added" : "Read again"} ${out.source.place}: ${out.places} ${out.source.kind === "website" ? "pages" : "files"} (${out.created} new, ${out.changed} changed, ${out.gone} gone)${out.complete === false ? ", the listing stopped at its limit" : ""}`);
      }
    } else if (command === "ask") {
      const question = words.join(" ");
      if (!question.trim()) throw new Error('genter ask "<question>"');
      const out = await g.find(question, { limit: flags.limit });
      if (out.added) console.error(`(searching ${out.added.source.place}, added as a source: genter forget ${out.added.source.place} to stop)`);
      if (semantic && out.semantic !== true) console.error(`(semantic ranking ${out.semantic || "off"})`);
      say(flags, out, findText(out));
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
      await serveMcp(g, { version });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
