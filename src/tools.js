import { z } from "zod";

// Shared by the CLI and the MCP server.
export const instructions = `Genter runs Composio tools and keeps reusable call recipes.
1. search first: a saved recipe (id + args) is faster than finding a tool again.
2. execute with tool + args, or with id to repeat a recipe (override args as needed).
3. After a successful call, save the recipe: pass description + tags to execute, or call save_recipe.
   Unsaved calls are deleted after an hour and the next search will not find them.
Write the description as a general recipe, not this one case:
  "<Verb> <object> — TOOL_SLUG, args: {a, b?}. Returns <what, format, size limits>. For another target override <args>."
Include the user's intent in plain words, tags in English and Russian, and pitfalls (format, truncation, alternatives).
If a saved recipe returns something different from its description, save_recipe with its id and status "outdated" and say why.`;

const recipeDescription = z
  .string()
  .describe('General recipe: "<Verb> <object> — TOOL_SLUG, args: {...}. Returns <what>. For another target override <args>."');
const recipeTags = z.array(z.string()).describe("Tags in English and Russian, e.g. readme, github, репозиторий");

export const tools = {
  register_tool: {
    description: "Connect an app (toolkit) like gmail or github. Returns a URL the user must open to authorize it.",
    input: z.object({ toolkit: z.string().describe("Composio toolkit slug, e.g. gmail, github, slack") }),
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
      "Run a tool and save it as a recipe. Pass `tool` + `args`, or `id` from search to repeat a recipe (args override). " +
      "Pass `description` + `tags` to save the recipe in the same call; otherwise the response's `next` holds a draft for save_recipe. " +
      "Unsaved calls are deleted after an hour and search will not find them.",
    input: z.object({
      id: z.string().optional().describe("id of a saved recipe to repeat"),
      tool: z.string().optional().describe("Tool slug, e.g. GMAIL_FETCH_EMAILS"),
      args: z.record(z.string(), z.any()).optional(),
      description: recipeDescription.optional(),
      tags: recipeTags.optional(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  save_recipe: {
    description:
      "Required after a successful execute (unless it got a description): save the call as a reusable recipe so search finds it. " +
      "If a saved recipe returned something different from its description, save it with status 'outdated' and say why.",
    input: z.object({
      id: z.string(),
      description: recipeDescription,
      tags: recipeTags.optional(),
      status: z.enum(["valid", "outdated"]).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};
