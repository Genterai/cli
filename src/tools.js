import { z } from "zod";

// Shared by the CLI and the MCP server.
export const instructions = `Genter runs Composio tools and keeps reusable call recipes.
1. search first: a saved recipe (id + args) is faster than finding a tool again.
2. execute with tool + args, or with id to repeat a recipe (override args as needed).
3. Save every successful step as a recipe, intermediate ones too (e.g. finding a repo before reading its README):
   pass description + tags to execute, or save all steps at once with save_recipes.
   Unsaved calls are deleted after an hour and the next search will not find them.
Write the description as a general recipe, not this one case:
  "<Verb> <object> — TOOL_SLUG, args: {a, b?}. Returns <what, format, size limits>. For another target override <args>."
Include the user's intent in plain words, tags in English and Russian, and pitfalls (format, truncation, alternatives).
If a saved recipe returns something different from its description, save it again with status "outdated" and say why.`;

const recipeDescription = z
  .string()
  .describe('General recipe: "<Verb> <object> — TOOL_SLUG, args: {...}. Returns <what>. For another target override <args>."');
const recipeTags = z.array(z.string()).describe("Tags in English and Russian, e.g. readme, github, репозиторий");

export const tools = {
  register_tool: {
    description: "Connect an app (toolkit) like gmail or github. Returns a URL the user must open to authorize it.",
    input: z.object({
      toolkit: z.string().describe("Composio toolkit slug, e.g. gmail, github, slack"),
      callback_url: z.string().url().optional().describe("Where to send the user after connecting (gets ?status=success|failed)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  login: {
    description: "Show the current user and connected apps.",
    input: z.object({}),
    annotations: { readOnlyHint: true },
  },
  search: {
    description:
      "Find a tool for a task. Returns saved recipes first ({id, tool, args, tags, description, status}); " +
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
      "Pass `description` + `tags` to save it as a recipe in the same call. Otherwise `next` holds a ready save_recipes call " +
      "with every unsaved step of the last hour: fill in descriptions and save them all at once.",
    input: z.object({
      id: z.string().optional().describe("id of a saved recipe to repeat"),
      tool: z.string().optional().describe("Tool slug, e.g. GMAIL_FETCH_EMAILS"),
      args: z.record(z.string(), z.any()).optional(),
      description: recipeDescription.optional(),
      tags: recipeTags.optional(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  save_recipes: {
    description:
      "Save successful calls as reusable recipes so search finds them, several at once. Save every step, intermediate ones too. " +
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
