import { z } from "zod";

// Tool descriptions and inputs, shared by the CLI and the MCP server.
export const tools = {
  register_tool: {
    description: "Connect an app (toolkit) like gmail or github. Returns a URL the user must open to authorize it.",
    input: { toolkit: z.string().describe("Composio toolkit slug, e.g. gmail, github, slack") },
  },
  login: {
    description: "Show the current user and connected apps.",
    input: {},
  },
  search: {
    description:
      "Find a tool for a task. Returns remembered calls first ({id, tool, args, tags, description, status}); " +
      "if memory has nothing valid, returns Composio tools (id: null, args = JSON schema).",
    input: {
      query: z.string().describe("What you want to do, in plain words"),
      limit: z.number().int().min(1).max(20).optional(),
    },
  },
  execute: {
    description:
      "Run a tool. Pass `tool` + `args`, or `id` from search to repeat a remembered call (args override). " +
      "Returns {id, result}. Afterwards call add_memory with this id so future searches find it.",
    input: {
      id: z.string().optional().describe("id of a previous call to repeat"),
      tool: z.string().optional().describe("Tool slug, e.g. GMAIL_FETCH_EMAILS"),
      args: z.record(z.string(), z.any()).optional(),
    },
  },
  add_memory: {
    description:
      "Describe what a call (by id) does and returns, so search finds it next time. " +
      "If a remembered call returned something different from its description, add a memory with status 'outdated' and say why.",
    input: {
      id: z.string(),
      description: z.string().describe("What this call does and what it returned"),
      tags: z.array(z.string()).optional(),
      status: z.enum(["valid", "outdated"]).optional(),
    },
  },
};
