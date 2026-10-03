import { z } from "zod";

// Shared by the CLI and the MCP server.
export const instructions = `Genter runs Composio tools and keeps reusable call recipes.
1. search first: a saved recipe (id + args) is faster than finding a tool again.
2. execute with tool + args, or with id to repeat a recipe (override args as needed).
3. Every successful call is saved as a recipe automatically, with a short summary of its result
   (topics, names, ids to open it again). Search by topic, e.g. an email subject, finds the call that returned it;
   then execute with the ids from its summary to dig deeper.
   Make recipes easier to find: pass description + short + tags to execute, or improve several at once with save_recipes.
4. An app can be connected several times (e.g. work and personal gmail): login lists the connections,
   pass \`account\` to execute to pick one; without it the default connection is used.
Write the description as a general recipe in Markdown, not this one case:
  ### <Verb> <object>
  \`TOOL_SLUG\` · args: \`{a, b?}\`
  Returns <what, format, size limits>. For another target override <args>.
  - pitfall: <format, truncation, alternatives>
Also pass \`short\`: one line under 100 characters for compact lists (the description is shown when a card is opened).
Include the user's intent in plain words, tags in English and Russian, and pitfalls.
If a saved recipe returns something different from its description, save it again with status "outdated" and say why.`;

const recipeDescription = z
  .string()
  .describe(
    "General recipe in Markdown: a '### <Verb> <object>' heading, a line '`TOOL_SLUG` · args: `{...}`', " +
      "then what it returns, how to reuse it for another target, and '- ' bullets with pitfalls.",
  );
const recipeShort = z
  .string()
  .max(140)
  .describe("One line, under 100 characters, for compact lists: what the recipe does, e.g. 'Fetch unread emails from the inbox'");
const recipeTags = z.array(z.string()).describe("Tags in English and Russian, e.g. readme, github, репозиторий");

export const tools = {
  register_tool: {
    description: "Connect an app (toolkit) like gmail or github. Returns a URL the user must open to authorize it.",
    input: z.object({
      toolkit: z.string().describe("Composio toolkit slug, e.g. gmail, github, slack"),
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
      "Find a tool for a task, or a past result by its topic (e.g. an email subject). " +
      "Returns saved recipes first ({id, tool, args, description, short, summary of the result, when, tags, status}); " +
      "if none is valid, returns Composio tools (id: null, args = JSON schema).",
    input: z.object({
      query: z.string().describe("What you want to do, in plain words"),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  execute: {
    description:
      "Run a tool. Pass `tool` + `args`, or `id` from search to repeat a recipe (args override). " +
      "Every successful call is saved as a recipe automatically; pass `description` + `tags` to describe it better.",
    input: z.object({
      id: z.string().optional().describe("id of a saved recipe to repeat"),
      tool: z.string().optional().describe("Tool slug, e.g. GMAIL_FETCH_EMAILS"),
      args: z.record(z.string(), z.any()).optional(),
      account: z.string().optional().describe("Connection to use (account id or alias from login) when the app is connected several times"),
      description: recipeDescription.optional(),
      short: recipeShort.optional(),
      tags: recipeTags.optional(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  save_recipes: {
    description:
      "Improve the descriptions of saved calls (ids from execute), several at once, so search finds them better. " +
      "If a saved recipe returned something different from its description, save it again with status 'outdated' and say why.",
    input: z.object({
      recipes: z
        .array(
          z.object({
            id: z.string().describe("id returned by execute"),
            description: recipeDescription,
            short: recipeShort.optional(),
            tags: recipeTags.optional(),
            status: z.enum(["valid", "outdated"]).optional(),
          }),
        )
        .min(1),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

// MCP surface: only agent tools. Each one starts or continues a fast server-side agent that works from recipes first.
// Names carry the GENTER_ prefix so they stay recognizable in clients that flatten tools from many servers.
const APPS =
  "Gmail, Google Calendar, Drive, Sheets, Docs, Slack, GitHub, Notion, Linear, Jira, HubSpot, Salesforce, Outlook, Teams, " +
  "Telegram, Discord, Asana, Trello, Figma, Stripe, Shopify, Airtable, Zoom and 500+ more";

export const agentInstructions = `Genter connects the user's apps (${APPS}) in one place and works in them with a fast agent that remembers what worked:
every successful call becomes a recipe, found next time by what it does and by what it returned.
- GENTER_FIND: any question about the user's own data (emails, events, files, issues, messages, contacts). Read-only.
- GENTER_RUN_TASK: anything that does something in an app: send, reply, create, update, schedule, post, move, multi-app workflows.
- GENTER_CONTINUE_TASK: answer a run's question, continue after the user connected an app, or a follow-up on the same result.
Call them whenever the user mentions or implies an app, an account or their own data. Never say you have no access before trying.
Pass the whole task with every known detail in one call, in the user's words; do not split it or call app tools step by step.
Show connect links to the user as Markdown links.`;

// connected: [{ toolkit, alias? }] — listed in descriptions so clients prefer apps the user already has.
export function agentTools({ connected = [] } = {}) {
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
        "If the result has status needs_input or needs_connection, show the question or the connect link to the user, " +
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
        "Searches by meaning across everything fetched before (summaries of past results, with ids to open them), " +
        "then reads live data from the apps when needed, so repeat questions answer instantly.\n" +
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
  };
}

// The agent's result as MCP tool text: the answer first, then what the client needs to continue.
export function agentResultText(out) {
  const next = {
    needs_input: "Ask the user this question, then call GENTER_CONTINUE_TASK with run_id and their answer.",
    needs_connection: "Show the connect link to the user as a Markdown link; when they have connected, call GENTER_CONTINUE_TASK with run_id.",
  }[out.status];
  const meta = {
    run_id: out.run_id,
    status: out.status,
    ...(out.connect_url && { connect_url: out.connect_url }),
    ...(out.steps?.length && { steps: out.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.tool}${s.recipe ? " (recipe)" : ""}`) }),
    ...(out.credits != null && { credits: out.credits }),
    ...(out.usage?.ms != null && { ms: out.usage.ms }),
    ...(next && { next }),
  };
  return `${out.answer ?? ""}\n\n${JSON.stringify(meta)}`;
}
