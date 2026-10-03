import { z } from "zod";

// Shared by the CLI and the MCP server.
export const instructions = `Genter runs Composio tools and keeps reusable call recipes.
1. search first: a saved recipe (id + args) is faster than finding a tool again.
2. execute with tool + args, or with id to repeat a recipe (override args as needed).
3. Every successful call is saved as a recipe automatically, with a short summary of its result
   (topics, names, ids to open it again). Search by topic, e.g. an email subject, finds the call that returned it;
   then execute with the ids from its summary to dig deeper.
   Make recipes easier to find: pass description + tags to execute, or improve several at once with save_recipes.
4. An app can be connected several times (e.g. work and personal gmail): login lists the connections,
   pass \`account\` to execute to pick one; without it the default connection is used.
Write the description as a general recipe in Markdown, not this one case:
  ### <Verb> <object>
  \`TOOL_SLUG\` · args: \`{a, b?}\`
  Returns <what, format, size limits>. For another target override <args>.
  - pitfall: <format, truncation, alternatives>
Include the user's intent in plain words, tags in English and Russian, and pitfalls.
If a saved recipe returns something different from its description, save it again with status "outdated" and say why.`;

const recipeDescription = z
  .string()
  .describe(
    "General recipe in Markdown: a '### <Verb> <object>' heading, a line '`TOOL_SLUG` · args: `{...}`', " +
      "then what it returns, how to reuse it for another target, and '- ' bullets with pitfalls.",
  );
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
      "Returns saved recipes first ({id, tool, args, description, summary of the result, when, tags, status}); " +
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
            tags: recipeTags.optional(),
            status: z.enum(["valid", "outdated"]).optional(),
          }),
        )
        .min(1),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};
