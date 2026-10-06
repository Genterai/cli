import { z } from "zod";
import { fileEditor, refLabel } from "./refs.js";

// Shared by the CLI and the MCP server.
export const instructions = `Genter runs Composio tools and remembers each successful call as a recipe: one call with fixed args, plus what it returned.
1. search first: a saved recipe says which call (tool + args) answers a question. Its summary is what the call returned when it was saved, not the current value.
2. execute with tool + args, or with id to repeat a recipe (override args as needed). The real tool always runs, so the data is fresh.
3. Every successful call is saved automatically; the same call updates the same recipe, and only when its result changed. A failed call saves nothing.
4. An app can be connected several times (e.g. work and personal gmail): login lists the connections,
   pass \`account\` to execute to pick one; without it the default connection is used.`;

export const tools = {
  register_tool: {
    description:
      "Connect an app (toolkit) like gmail or github, or any remote MCP server by its address (mcp_url). Returns a URL the user must open " +
      "to authorize it; a server that needs no sign-in is connected at once (no_auth, no URL).",
    input: z.object({
      toolkit: z.string().optional().describe("Composio toolkit slug, e.g. gmail, github, slack"),
      mcp_url: z.string().url().optional().describe("Instead of toolkit: a remote MCP server's address, e.g. https://mcp.example.com/mcp. Added as a custom toolkit"),
      name: z.string().max(60).optional().describe("With mcp_url: the server's name to show"),
      api_key_header: z.string().max(80).optional().describe("With mcp_url: the server takes an API key in this header (Authorization: as a Bearer token)"),
      callback_url: z.string().url().optional().describe("Where to send the user after connecting (gets ?status=success|failed)"),
      alias: z.string().optional().describe("Name for this connection when the app is connected more than once, e.g. work"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  login: {
    description: "Show the current user and connected apps, one entry per connection ({toolkit, account, alias, status}).",
    input: z.object({}),
    annotations: { readOnlyHint: true },
  },
  search: {
    description:
      "Find which call to make: a saved recipe by what its result meant ({id, tool, args, title, short, summary, status, updated_at, checked_at}), " +
      "or Composio tools (id: null, args = JSON schema). A recipe's summary is not the current value: execute it.",
    input: z.object({
      query: z.string().describe("What you want to do, in plain words"),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  execute: {
    description:
      "Run a tool. Pass `tool` + `args`, or `id` from search to repeat a recipe (args override). " +
      "Every successful call is saved as a recipe automatically (the same call updates the same one).",
    input: z.object({
      id: z.string().optional().describe("id of a saved recipe to repeat"),
      tool: z.string().optional().describe("Tool slug, e.g. GMAIL_FETCH_EMAILS"),
      args: z.record(z.string(), z.any()).optional(),
      account: z.string().optional().describe("Connection to use (account id or alias from login) when the app is connected several times"),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  recipes: {
    description: "List saved recipes (id, title, source, status, updated and checked times, trigger state).",
    input: z.object({}),
    annotations: { readOnlyHint: true },
  },
  recheck_recipe: {
    description: "Run a saved recipe's call again: updated only if its result changed. Returns { recipe, changed, status }.",
    input: z.object({ id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  remove_recipe: {
    description: "Delete a saved recipe.",
    input: z.object({ id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
};

// MCP surface: only agent tools. Each one starts or continues a fast server-side agent that works from recipes first.
// GENTER_FIND and GENTER_CONTINUE_TASK only read; GENTER_RUN_TASK and GENTER_WRITE change things and come only with actions.
// Names carry the GENTER_ prefix so they stay recognizable in clients that flatten tools from many servers.
const APPS =
  "Gmail, Google Calendar, Drive, Sheets, Docs, Slack, GitHub, Notion, Linear, Jira, HubSpot, Salesforce, Outlook, Teams, " +
  "Telegram, Discord, Asana, Trello, Figma, Stripe, Shopify, Airtable, Zoom and 500+ more";

// What Genter does and what the client's own model does: Genter finds the user's data (and, with actions on, carries out
// an action the client has fully decided); the client's model reads, thinks and writes every text itself. Genter never
// writes, rewrites, summarizes or translates anything for it.
export const agentInstructions = `Genter connects the user's apps (${APPS}) in one place and finds what is in them, fast:
every successful call becomes a recipe (one call with fixed args), found next time by what it returned; the real call is always re-run for fresh data.
Genter finds; you think and write. Genter returns the raw data from the user's apps and never writes, rewrites, summarizes, translates or drafts anything:
do all of that yourself from the data it returns. Never ask Genter to change, rewrite, improve, shorten or compose a text.
- GENTER_FIND: any question about the user's own data (emails, events, files, issues, messages, contacts, docs, pages). Read-only. Returns raw data:
  the live results of the recipes that hold the answer (a saved one that fits, or new ones a fast agent finds and saves), each under a line naming its call. Answer from them yourself.
  Optional goal (what the task is for, e.g. "writing product docs"): also returns the user's matching skills and guides in a separate
  "Skills for the goal" section, never among the data, each once per chat (pass the same optional conversation_id in every call of a chat, a new one in a new chat). Leave it out when you only look something up.
  Ask only for what to find (who, what, when, which app), never for what to do with it: for "rewrite the intro of our README", find "the README of <repo>" and rewrite it yourself.
- GENTER_CONTINUE_TASK: answer a run's question, continue after the user connected an app, or narrow or widen the same search.
Call them whenever the user mentions or implies an app, an account or their own data. Never say you have no access before trying.
Pass every known detail (names, dates, apps, accounts) in one call, in the user's words.
Show connect links to the user as Markdown links.
References under GENTER_FIND's results (whose items carry _ref: n) say what each is and where: a path, a link, the ids that point to it.
A reference's "read" line is the GENTER_FIND call that reads that place in full (an email's body, a whole file, a skill's section, a page): make it when the answer needs more than the result shows.`;

// Added to the instructions where actions are on (Enterprise): the tools that change something in the user's apps.
export const actionInstructions = `Actions (this workspace may change things in its apps):
- GENTER_RUN_TASK: carry out an action you have fully decided: send, reply, create, update, schedule, post, move. Pass the exact final text
  (an email's body, a message, a comment, a title) word for word: Genter puts it there as given and writes nothing of its own.
- GENTER_WRITE: write where a result pointed: run_id + ref (the [n] of its References) + the exact text. Each reference's "write" line names the app's write tools for that exact place, args already known.
  A file: pass edits ([{find, replace}], exact pieces of its current text and the new text you wrote) and message: one commit, only those pieces change.
Write every text yourself first (from what GENTER_FIND returned), then hand it over; never ask Genter to write or rewrite it.`;

// connected: [{ toolkit, alias? }] — listed in descriptions so clients prefer apps the user already has.
// actions: also GENTER_RUN_TASK and GENTER_WRITE, the tools that change something (MCP: Enterprise only; everyone else reads).
export function agentTools({ connected = [], actions = false } = {}) {
  const apps = [...new Set(connected.map((c) => c.toolkit))];
  const have = apps.length ? `\nConnected for this user: ${apps.join(", ")}. Prefer these when the request does not name an app.` : "";
  const account = z.string().optional().describe("Which connection to use when an app is connected several times, e.g. work or personal");
  return {
    GENTER_FIND: {
      description:
        "Find anything in the user's apps: emails, messages, meetings, files, docs, pages, issues, PRs, contacts, deals, invoices. " +
        "Read-only and safe: nothing is sent or changed.\n" +
        "Returns raw data, not a written answer: the live results of the recipes (saved calls with fixed args) that hold what was asked, " +
        "best first, each under a line naming its call (recipe id, tool, args), then a JSON line. Read them and answer the user yourself.\n" +
        "Genter only finds. It never writes, rewrites, summarizes or translates: ask it for the data, then do that yourself. " +
        "Say what to find, not what to do with it: \"the README of genter-cli\", not \"rewrite the README of genter-cli\"; " +
        "\"Anna's last email about the contract\", not \"draft a reply to Anna\".\n" +
        "A saved recipe that clearly fits runs at once; otherwise a fast agent finds the right calls in the apps and saves them as recipes, " +
        "so the next such question takes one step. The data is always read live from the apps, so it is current.\n" +
        "Call it before answering any question about the user's own data instead of guessing or saying you can't see it: " +
        "\"what did Anna write about the contract\", \"my meetings tomorrow\", \"PRs waiting for my review\", \"the invoice from March\".\n" +
        "Optional `goal` (what the task is for, e.g. \"writing product documentation\"): also returns the user's matching skills and guides " +
        "in a separate \"Skills for the goal\" section, each once per chat. Pass the same `conversation_id` (an id you make up once per chat, new in a new chat) in every call of a chat so a skill is not repeated. " +
        "Example: {question: \"Evallens features\", goal: \"writing product documentation\", conversation_id: \"k3x9a2fq\"}. Both are optional." +
        have,
      input: z.object({
        question: z.string().describe("What to find, in plain words, with any known names, dates or apps. Only what to find, never what to do with it"),
        goal: z.string().optional().describe("Optional. What the task is for, in a few words (\"writing product documentation\"). Brings matching skills and guides in a separate section; leave it out when you only look something up"),
        conversation_id: z.string().max(200).optional().describe("Optional. One short id for this chat, the same in every call of this chat and new in a new chat (e.g. a random 8-character string you make up once). Keeps a skill from being shown twice in a chat"),
        model: z.string().max(100).optional().describe("Optional. Your model name, for the call log only"),
        account,
      }),
      annotations: { title: "Find in your apps", readOnlyHint: true, openWorldHint: true },
    },
    GENTER_CONTINUE_TASK: {
      description:
        `Continue a Genter run by run_id (from GENTER_FIND${actions ? " or GENTER_RUN_TASK" : ""}): send the user's answer to its question, ` +
        "say the app is connected now, or narrow or widen the same search (\"only last week\", \"use my work account\", \"the whole thread\"). " +
        "Keeps the run's context, so it is faster than a new search.\n" +
        (actions
          ? "A run of GENTER_FIND stays read-only. Never ask it to write, rewrite or summarize: do that yourself."
          : "Read-only: nothing is sent or changed. Never ask it to write, rewrite or summarize: do that yourself."),
      input: z.object({
        run_id: z.string().describe(`run_id returned by GENTER_FIND${actions ? " or GENTER_RUN_TASK" : ""}`),
        message: z.string().describe("The user's answer, or what else to find"),
      }),
      annotations: { title: "Continue a search", readOnlyHint: !actions, destructiveHint: false, openWorldHint: true },
    },
    ...(actions && {
      GENTER_RUN_TASK: {
        description:
          `Carry out an action in the user's apps (${APPS}): send, reply, create, update, schedule, post, move, ` +
          "or several of them across apps.\n" +
          "Only for an action you have fully decided. Genter does not write: every text the action needs (an email's body, a message, " +
          "a comment, an issue's title and description) is written by you and passed word for word, and is put there as given. " +
          "Not for finding things (use GENTER_FIND), and never for writing, rewriting, summarizing or translating a text.\n" +
          "Pass the whole action with every detail (who, where, when, which account, the exact text) in one call, e.g. " +
          "\"reply to Anna's last email with exactly: Thursday 3pm works for me.\" A fast agent picks the tools, fills the args and runs them. " +
          "If the result has status needs_connection, show the connect link to the user, then call GENTER_CONTINUE_TASK with run_id." +
          have,
        input: z.object({
          task: z.string().describe("The action with every known detail and the exact final text to put there, e.g. \"reply to Anna's last email with exactly: Thursday 3pm works for me.\""),
          account,
        }),
        annotations: { title: "Do an action in your apps", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      GENTER_WRITE: {
        description:
          "Write at a place a Genter result pointed to: a file, folder, issue, pull request, page, email thread, event, task, " +
          "ticket, card, record or chat message in any connected app, or at a link to it.\n" +
          "Every GENTER_FIND / GENTER_RUN_TASK answer cites [n] and lists References: what each is, its link, `where` (the ids " +
          "that point to it) and `write` (the app's write tools for that exact place, their args already known).\n" +
          "Genter does not write the text: you do, from what GENTER_FIND returned, and it goes there word for word. " +
          "A file: pass edits (exact pieces of its current text and the new text you wrote) + message: it is read and committed in one " +
          "commit with only those pieces changed, no agent step. An exact call: tool + args from the write line, the reference's args " +
          "filled in, give only the rest (a comment's body); no agent step. Otherwise run_id + ref (n) + change: the exact text and " +
          "where it goes (\"reply with exactly: ...\", \"comment exactly: ...\", \"move it to 3pm\").\n" +
          "Use for: edit or add a file in a repo, comment on or update an issue, PR, ticket or card, add to a Notion page, reply in an " +
          "email or Slack thread, change an event or a task, update a CRM record.",
        input: z.object({
          run_id: z.string().optional().describe("run_id of the result whose References hold the place"),
          ref: z
            .union([z.number().int(), z.string()])
            .optional()
            .describe("Which place: its reference number [n] in that result, or a link to it (GitHub file, folder, issue or PR; Notion page; Gmail thread; Calendar event)"),
          change: z.string().optional().describe("The exact text to put there, written by you, and where it goes, e.g. \"reply with exactly: Thursday 3pm works\", \"move it to 3pm\". Never a request to write or rewrite something"),
          edits: z
            .array(
              z.object({
                find: z.string().optional().describe("Exact current text of the file, a few whole lines, found once"),
                replace: z.string().optional().describe("What goes instead, written by you (empty deletes it)"),
                append: z.string().optional().describe("Instead of find/replace: text added at the end"),
              }),
            )
            .optional()
            .describe("For a file: the changes, applied in order and committed once; everything else stays as it is"),
          message: z.string().optional().describe("With edits: the commit message"),
          tool: z.string().optional().describe("For an exact call: a write tool from the reference's write line, e.g. GITHUB_CREATE_AN_ISSUE_COMMENT"),
          args: z.record(z.string(), z.any()).optional().describe("Its args besides the ones the reference fills in, e.g. {\"body\": \"Fixed in #43\"}"),
          account,
        }),
        annotations: { title: "Write where a result pointed", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
    }),
  };
}

// What the client does next with a run's result: answer its question, connect an app, or write at a reference.
const PAUSED = {
  needs_input: "Ask the user this question, then call GENTER_CONTINUE_TASK with run_id and their answer.",
  needs_connection: "Show the connect link to the user as a Markdown link; when they have connected, call GENTER_CONTINUE_TASK with run_id.",
};
const nextOf = (out, refs, write) =>
  PAUSED[out.status] ??
  (write && out.run_id && refs.some((r) => r.write?.length)
    ? "To write at a reference, with a text you wrote yourself (it goes there word for word): GENTER_WRITE {run_id, ref: n, change}; a file: {run_id, ref, edits: [{find, replace}], message}, one commit with only those pieces changed; an exact call: tool + args from its write line (the reference's args are filled in)."
    : undefined);

// The agent's result as MCP tool text: the answer first, its References (what each [n] is, where, and with write on,
// how to write there), then what the client needs to continue.
export function agentResultText(out, { write = false } = {}) {
  const refs = out.references ?? [];
  const next = nextOf(out, refs, write);
  const meta = {
    run_id: out.run_id,
    status: out.status,
    ...(out.connect_url && { connect_url: out.connect_url }),
    ...(out.steps?.length && { steps: out.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.tool}${s.recipe ? " (recipe)" : ""}`) }),
    ...(out.suggestions?.length && { suggestions: out.suggestions }),
    ...(out.credits != null && { credits: out.credits }),
    ...(out.usage?.ms != null && { ms: out.usage.ms }),
    ...(next && { next }),
  };
  const listed = refs.length ? `\n\nReferences:\n${refs.map((r) => referenceText(r, write, { read: true })).join("\n")}` : "";
  return `${out.answer ?? ""}${listed}\n\n${JSON.stringify(meta)}`;
}

// GENTER_FIND's result: the raw results of the recipes that hold the answer, best first: { results: [{ id, tool, args,
// title?, account?, score?, created, changed, instructions?, data }] }. Each is a saved call run live just now: a saved
// recipe that fits (out.direct: no model at all), or the calls an agent run in mode "recipes" found and saved. Each comes
// under a line naming its call, as it came (file contents sent as base64 decoded); then their References (with write on,
// how to write there) and a JSON line. No model wrote an answer: the client's own model answers from the data, so the
// person's prompt (instructions) and the prompts of the recipes' projects go along in the JSON as `instructions`.
// A run that found nothing, or stopped to ask or for a connection, says so first, in the agent's words.
export function recipesResultText(out, { write = false, instructions } = {}) {
  const results = out.results ?? [];
  const refs = out.references ?? [];
  const said = String(out.answer ?? "").trim();
  const note = said && (!results.length || out.status !== "done") ? said : "";
  const blocks = results.map((r, i) => `${recipeLine(r, i + 1)}\n${JSON.stringify(readable(r.data) ?? null)}`);
  // Skills and guides picked by GENTER_FIND's goal: their own section after the data, never counted among the recipes.
  const skills = out.skills ?? [];
  const skillBlocks = skills.length
    ? [`Skills for the goal (guides on how to do it, not data to answer from):\n\n${skills.map((r, i) => `Skill ${i + 1}: ${recipeLine(r, i + 1).replace(/^Recipe \d+: /, "")}\n${JSON.stringify(readable(r.data) ?? null)}`).join("\n\n")}`]
    : [];
  const told = [instructions, ...results.map((r) => r.instructions)].map((t) => String(t ?? "").trim()).filter((t, i, all) => t && all.indexOf(t) === i);
  const next = nextOf(out, refs, write);
  const meta = {
    ...(out.run_id && { run_id: out.run_id }),
    status: out.status ?? "done",
    ...(out.direct && { direct: true }),
    recipes: results.map((r) => ({ id: r.id, tool: r.tool, ...(r.score != null && { score: r.score }), ...(r.created && { created: true }), ...(r.changed && { changed: true }) })),
    ...(skills.length && { skills: skills.map((r) => ({ id: r.id, tool: r.tool, ...(r.score != null && { score: r.score }) })) }),
    ...(told.length && { instructions: told.join("\n\n") }),
    ...(out.connect_url && { connect_url: out.connect_url }),
    ...(out.suggestions?.length && { suggestions: out.suggestions }),
    ...(out.credits != null && { credits: out.credits }),
    ...(out.usage?.ms != null && { ms: out.usage.ms }),
    ...(next && { next }),
  };
  // A result that is one source (a file, a page) is here in full: only the items of a list get a "read" line.
  const listed = refs.length ? `References:\n${refs.map((r) => referenceText(r, write, { read: r.via !== "call" })).join("\n")}` : "";
  return [note, ...blocks, ...skillBlocks, listed, JSON.stringify(meta)].filter(Boolean).join("\n\n");
}

// Recipe 1: rcp_… · GMAIL_FETCH_EMAILS {"query":"from:anna"} — Emails from Anna (account work)
const recipeLine = (r, i) =>
  `Recipe ${i}: ${[r.id, r.tool].filter(Boolean).join(" · ")}${Object.keys(r.args ?? {}).length ? ` ${JSON.stringify(r.args)}` : ""}${r.title ? ` — ${r.title}` : ""}${r.account ? ` (account ${r.account})` : ""}`;

// A result as the app sent it, except file contents sent as base64 (GitHub's {encoding: "base64", content}, at the top
// or one level down): decoded, so a model can read them. Contents that are not text stay as they came.
export function readable(data) {
  const decoded = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || v.encoding !== "base64" || typeof v.content !== "string") return v;
    const text = Buffer.from(v.content, "base64").toString("utf8");
    return /[\u0000\uFFFD]/.test(text) ? v : { ...v, encoding: "utf-8", content: text };
  };
  const top = decoded(data);
  if (top !== data || !top || typeof top !== "object" || Array.isArray(top)) return top;
  const inner = Object.entries(top).map(([k, v]) => [k, decoded(v)]);
  return inner.some(([k, v]) => v !== top[k]) ? Object.fromEntries(inner) : top;
}

// [3] github file Genterai/genter-cli/src/agent.js — https://github.com/...
//     where {"owner":"Genterai","repo":"genter-cli","path":"src/agent.js","branch":"main"}
//     read  GENTER_FIND {"question":"Read the github file \"Genterai/genter-cli/src/agent.js\" in full: https://github.com/..."}
//     edit  {edits: [{find, replace}], message}: one commit, only those pieces change
//     write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS(message, content)
// read: with the follow-up that reads the place in full (readQuestion), for a client's model to make when it needs more.
export function referenceText(r, write = false, { read = false } = {}) {
  const lines = [`[${r.n}] ${[r.app, r.kind].filter(Boolean).join(" ")} ${refLabel(r)}${r.of ? ` (${r.of})` : ""}${r.url ? ` — ${r.url}` : ""}`];
  if (r.where && Object.keys(r.where).length) lines.push(`    where ${JSON.stringify(r.where)}`);
  const question = read && readQuestion(r);
  if (question) lines.push(`    read  GENTER_FIND ${JSON.stringify({ question })}`);
  if (write && fileEditor(r)) lines.push("    edit  {edits: [{find, replace}], message}: one commit, only those pieces change");
  if (write && r.write?.length) lines.push(`    write ${r.write.map((h) => `${h.tool}(${h.needs.join(", ")})`).join(" · ")}`);
  return lines.join("\n");
}

// The request that reads a reference in full, as Search asks it when a source is clicked: what it is, its name, and where it
// is (a link, else the ids that point to it), so the agent makes the one call that reads it (a saved recipe of it runs
// at once). A skill's piece: "Read the docs-writing skill: SKILL.md#install".
export function readQuestion(r) {
  if (!r) return null;
  const w = r.where ?? {};
  if (r.app === "skill") {
    const piece = w.chunk ?? w.id ?? w.path ?? r.path;
    const name = r.of ?? (r.title && r.title !== piece ? r.title : null);
    return `Read the ${name ? `${name} skill` : "skill"}${piece ? `: ${piece}` : ""}`;
  }
  const what = [r.app === "website" ? null : r.app, r.kind].filter(Boolean).join(" ") || "item";
  const label = refLabel(r);
  const name = label && label !== r.kind ? ` "${label}"` : "";
  if (r.url) return `Read the ${what}${name} in full: ${r.url}`;
  return `Read the ${what}${name} in full${Object.keys(w).length ? ` ${JSON.stringify(w)}` : ""}`;
}
