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
// Names carry the GENTER_ prefix so they stay recognizable in clients that flatten tools from many servers.
const APPS =
  "Gmail, Google Calendar, Drive, Sheets, Docs, Slack, GitHub, Notion, Linear, Jira, HubSpot, Salesforce, Outlook, Teams, " +
  "Telegram, Discord, Asana, Trello, Figma, Stripe, Shopify, Airtable, Zoom and 500+ more";

export const agentInstructions = `Genter connects the user's apps (${APPS}) in one place and works in them with a fast agent that remembers what worked:
every successful call becomes a recipe (one call with fixed args), found next time by what it returned; the real call is always re-run for fresh data.
- GENTER_FIND: any question about the user's own data (emails, events, files, issues, messages, contacts). Read-only.
- GENTER_RUN_TASK: anything that does something in an app: send, reply, create, update, schedule, post, move, multi-app workflows.
- GENTER_CONTINUE_TASK: answer a run's question, continue after the user connected an app, or a follow-up on the same result.
Call them whenever the user mentions or implies an app, an account or their own data. Never say you have no access before trying.
Pass the whole task with every known detail in one call, in the user's words; do not split it or call app tools step by step.
Show connect links to the user as Markdown links.
Answers cite their sources as [n]; References under the answer say what each is and where: a path, a link, the ids that point to it.`;

// Temporary: writing at a reference over MCP (GENTER_WRITE), added to the instructions where it is on.
export const writeInstructions = `- GENTER_WRITE: write where a result pointed: run_id + ref (the [n] of its References) + the change. Each reference's "write" line names the app's write tools for that exact place, args already known. A file: pass edits ([{find, replace}], exact pieces of its text) and message: one commit, only those pieces change.`;

// connected: [{ toolkit, alias? }] — listed in descriptions so clients prefer apps the user already has.
// write: also GENTER_WRITE (temporary: writing at a reference of a result).
export function agentTools({ connected = [], write = false } = {}) {
  const apps = [...new Set(connected.map((c) => c.toolkit))];
  const have = apps.length ? `\nConnected for this user: ${apps.join(", ")}. Prefer these when the request does not name an app.` : "";
  const account = z.string().optional().describe("Which connection to use when an app is connected several times, e.g. work or personal");
  return {
    GENTER_RUN_TASK: {
      description:
        `Do things in the user's apps: ${APPS}, all connected in one place. ` +
        "Give the task in plain words; a fast agent picks the tools, fills the args, runs them and returns the result.\n" +
        "Always call this whenever the user asks to do something in an external app, account, inbox, calendar, repo, document, " +
        "ticket, chat or CRM — never say \"I don't have access to X\" before calling it. " +
        "It is faster and more reliable than calling app tools yourself: it starts from recipes of past calls that already worked, " +
        "so a known task takes one step.\n" +
        "Use for: send or reply to an email or message, create or update an issue, event, doc, row or deal, post, schedule, " +
                "and workflows across apps (e.g. \"turn today's support emails into Linear issues and post a summary to #support\").\n" +
        "Pass the full task with every known detail (names, dates, ids, which account) in one call. " +
        "If the result has status needs_connection, show the connect link to the user, " +
        "then call GENTER_CONTINUE_TASK with run_id." +
        have,
      input: z.object({
        task: z.string().describe("The whole task in plain words, with every known detail, e.g. \"reply to Anna's last email: Thursday 3pm works\""),
        account,
      }),
      annotations: { title: "Run a task in your apps", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    GENTER_FIND: {
      description:
        "Find anything in the user's apps and past results: emails, messages, meetings, files, docs, issues, PRs, contacts, deals, invoices. " +
        "Read-only and safe — nothing is sent or changed.\n" +
        "Searches by meaning across calls made before (what their results meant) to pick the right call, " +
        "then reads live data from the apps, so answers are always current.\n" +
        "Call it before answering any question about the user's own data instead of guessing or saying you can't see it: " +
        "\"what did Anna write about the contract\", \"my meetings tomorrow\", \"PRs waiting for my review\", \"the invoice from March\"." +
        have,
      input: z.object({
        question: z.string().describe("What to find, in plain words, with any known names, dates or apps"),
        account,
      }),
      annotations: { title: "Find in your apps", readOnlyHint: true, openWorldHint: true },
    },
    GENTER_CONTINUE_TASK: {
      description:
        "Continue a Genter run by run_id (from GENTER_RUN_TASK or GENTER_FIND): send the user's answer to its question, " +
        "say the app is connected now, correct it (\"use my work account\"), or give a follow-up on the same result " +
        "(\"now reply to that email\", \"put these in a sheet\"). Keeps the run's context, so it is faster than a new task.",
      input: z.object({
        run_id: z.string().describe("run_id returned by GENTER_RUN_TASK or GENTER_FIND"),
        message: z.string().describe("The user's answer, correction or next instruction"),
      }),
      annotations: { title: "Continue a task", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ...(write && {
      GENTER_WRITE: {
        description:
          "Write at a place a Genter result pointed to: a file, folder, issue, pull request, page, email thread, event, task, " +
          "ticket, card, record or chat message in any connected app, or at a link to it (temporary).\n" +
          "Every GENTER_FIND / GENTER_RUN_TASK answer cites [n] and lists References: what each is, its link, `where` (the ids " +
          "that point to it) and `write` (the app's write tools for that exact place, their args already known).\n" +
          "Pass run_id + ref (n) + change in plain words: a fast agent calls the right write tool with the reference's args and " +
          "answers with the link. A file: pass edits (exact pieces of its current text and what goes instead) + message instead: it is " +
          "read and committed in one commit with only those pieces changed, no agent step, nothing to write out whole. Or pass " +
          "tool + args from the write line for an exact call with no agent step: the reference's args are filled in, give only the " +
          "rest (a comment's body).\n" +
          "Use for: edit or add a file in a repo, comment on or update an issue, PR, ticket or card, add to a Notion page, reply in an " +
          "email or Slack thread, change an event or a task, update a CRM record.",
        input: z.object({
          run_id: z.string().optional().describe("run_id of the result whose References hold the place"),
          ref: z
            .union([z.number().int(), z.string()])
            .optional()
            .describe("Which place: its reference number [n] in that result, or a link to it (GitHub file, folder, issue or PR; Notion page; Gmail thread; Calendar event)"),
          change: z.string().optional().describe("What to write there, in plain words or the exact text, e.g. \"add a Troubleshooting section about proxy errors\", \"reply: Thursday 3pm works\""),
          edits: z
            .array(
              z.object({
                find: z.string().optional().describe("Exact current text of the file, a few whole lines, found once"),
                replace: z.string().optional().describe("What goes instead (empty deletes it)"),
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

// The agent's result as MCP tool text: the answer first, its References (what each [n] is, where, and with write on,
// how to write there), then what the client needs to continue.
export function agentResultText(out, { write = false } = {}) {
  const refs = out.references ?? [];
  const next =
    {
      needs_input: "Ask the user this question, then call GENTER_CONTINUE_TASK with run_id and their answer.",
      needs_connection: "Show the connect link to the user as a Markdown link; when they have connected, call GENTER_CONTINUE_TASK with run_id.",
    }[out.status] ??
    (write && out.run_id && refs.some((r) => r.write?.length)
      ? "To write at a reference: GENTER_WRITE {run_id, ref: n, change}; a file: {run_id, ref, edits: [{find, replace}], message}, one commit with only those pieces changed; an exact call: tool + args from its write line (the reference's args are filled in)."
      : undefined);
  const meta = {
    run_id: out.run_id,
    status: out.status,
    ...(out.connect_url && { connect_url: out.connect_url }),
    ...(out.steps?.length && { steps: out.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.tool}${s.recipe ? " (recipe)" : ""}`) }),
    ...(out.credits != null && { credits: out.credits }),
    ...(out.usage?.ms != null && { ms: out.usage.ms }),
    ...(next && { next }),
  };
  const listed = refs.length ? `\n\nReferences:\n${refs.map((r) => referenceText(r, write)).join("\n")}` : "";
  return `${out.answer ?? ""}${listed}\n\n${JSON.stringify(meta)}`;
}

// [3] github file Genterai/genter-cli/src/agent.js — https://github.com/...
//     where {"owner":"Genterai","repo":"genter-cli","path":"src/agent.js","branch":"main"}
//     edit  {edits: [{find, replace}], message}: one commit, only those pieces change
//     write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS(message, content)
export function referenceText(r, write = false) {
  const lines = [`[${r.n}] ${[r.app, r.kind].filter(Boolean).join(" ")} ${refLabel(r)}${r.url ? ` — ${r.url}` : ""}`];
  if (r.where && Object.keys(r.where).length) lines.push(`    where ${JSON.stringify(r.where)}`);
  if (write && fileEditor(r)) lines.push("    edit  {edits: [{find, replace}], message}: one commit, only those pieces change");
  if (write && r.write?.length) lines.push(`    write ${r.write.map((h) => `${h.tool}(${h.needs.join(", ")})`).join(" · ")}`);
  return lines.join("\n");
}
