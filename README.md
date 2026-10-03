# genter

Composio tools with saved call recipes. An AI agent finds a tool and runs it; every successful call is saved as a recipe: what it does and with which args.
Each recipe also keeps a short summary of what the call returned (topics, names, ids to open it again),
so `search` finds a past result by its topic, e.g. an email subject, and the agent knows where to dig.

On top of that, an agent does whole tasks fast: before its first LLM call it already has the matching recipes,
candidate tools with compact arg schemas and the connected apps, so a known task is one tool call, and a result summary
can answer a question with no call at all. The hosted MCP server exposes only the agent.

```
run          → the agent does a task in your apps, recipes first
find         → read-only agent: answers from past results, reads live data if needed
continue     → answer a run's question or give a follow-up

search       → saved recipes first, Composio tools if none is valid
execute      → runs a tool (or repeats a recipe by id) and saves it as a recipe; description + tags make it easier to find
save_recipes → improves descriptions of several recipes at once; each description is embedded for search
```

Without a description, `execute` saves the recipe with Composio's generic tool description, so every step,
intermediate ones too, is found next time. The same tool + args is not saved twice. Failed calls are not recorded.
If a recipe stops matching its description, the agent saves it with `status: "outdated"` and says why.
Search then falls back to Composio again.

Recipes are Markdown, written as general recipes, not one case:

```md
### Fetch unread emails
`GMAIL_FETCH_EMAILS` · args: `{query, max_results?}`
Returns a list of messages. For other filters override `query`.
- pitfall: bodies are truncated, open one with `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`
```

plus tags in English and Russian. The MCP server sends these rules to clients as `instructions`.

## Install

```bash
npm i -g github:Genterai/genter-cli
genter login '{"composio_api_key":"...","openrouter_api_key":"...","user_id":"me"}'
```

Keys can also come from env: `COMPOSIO_API_KEY`, `OPENROUTER_API_KEY`, `GENTER_USER_ID`.
The OpenRouter key is used for embeddings (`EMBEDDING_MODEL`, default `openai/text-embedding-3-small`).
Without it, `search` uses Composio only.

## Tools

| tool | input | output |
| --- | --- | --- |
| `register_tool` | `{toolkit, alias?}` | `{toolkit, connect_url, connection_id}` — open the URL to connect the app; an app can be connected several times |
| `login` | `{}` | `{user_id, connected: [{toolkit, account, alias, status}]}` |
| `search` | `{query, limit?}` | `[{id, tool, args, description, summary, when, tags, status}]` |
| `execute` | `{tool, args}` or `{id, args?}`, optional `{account, description, tags}` | `{id, result, summary, saved?, note?}` |
| `save_recipes` | `{recipes: [{id, description, tags?, status?}]}` | `[{id, created_at, tags, description, status}]` |

```bash
genter register_tool '{"toolkit":"gmail"}'
genter search '{"query":"unread emails from today"}'
genter execute '{"tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread newer_than:1d"},
  "description":"### Fetch unread emails\n`GMAIL_FETCH_EMAILS` · args: `{query, max_results?}`\nReturns a list of messages. For other filters override `query`.",
  "tags":["gmail","inbox","почта","письма"]}'
```

## Agent

```bash
genter run '{"task":"reply to Anna\'s last email: Thursday 3pm works"}'
genter find '{"question":"what did Anna write about the contract?"}'
genter continue '{"run_id":"...","message":"use my work account"}'
```

A run ends `done`, `needs_input` (a question), `needs_connection` (a connect link) or `failed`; `continue` picks it up.
`find` runs only tools that read (by Composio's hint or the verb in the slug). New calls are saved as recipes with
the agent's description, so the next run finds them. The model is `AGENT_MODEL` on OpenRouter, default `openai/gpt-oss-20b`.

```js
import { createAgent } from "genter-cli/agent";
import { agentTools, agentInstructions, agentResultText } from "genter-cli/tools"; // MCP definitions

const agent = createAgent({ genter, openrouterApiKey, secret, userId, runs }); // runs: get(id), put({id, blob})
const out = await agent.start({ task: "my meetings tomorrow", mode: "find" });
await agent.send({ run_id: out.run_id, message: "only the work calendar" });
```

## Data

- Raw tool results are never stored, only a 1-3 sentence summary written by an LLM through OpenRouter
  (`SUMMARY_MODEL`, default `openai/gpt-oss-20b`). The same call with the same result is not saved twice.
- Every record (tool, args, description, summary, embedding) is encrypted with AES-256-GCM before it is stored.
  The store only sees `{id, remembered, blob}`. The CLI keeps its key in `~/.genter/config.json` and data in `~/.genter/calls.json`.
- Agent runs are encrypted the same way (`~/.genter/runs.json`). Tool results in them are replaced by their summaries
  before they are stored; a follow-up re-runs the recipe when it needs details.

## Hosted MCP

The agent tools (`GENTER_RUN_TASK`, `GENTER_FIND`, `GENTER_CONTINUE_TASK`) run as a remote MCP server with OAuth (Google or email) in
[genter-backend](https://github.com/Genterai/genter-backend).

## Library

```js
import { createGenter } from "genter-cli";
import { tools } from "genter-cli/tools";

const genter = createGenter({ composioApiKey, openrouterApiKey, userId, secret, store }); // store: get(id), put(row), all()
await genter.search({ query: "send a slack message" });
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for noncommercial use. Commercial use requires a separate license.
