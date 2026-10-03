# genter

Composio tools with saved call recipes. An AI agent finds a tool and runs it; every successful call is saved as a recipe: what it does and with which args.
Each recipe also keeps a short summary of what the call returned (topics, names, ids to open it again),
so `search` finds a past result by its topic, e.g. an email subject, and the agent knows where to dig.

```
search       → saved recipes first, Composio tools if none is valid
execute      → runs a tool (or repeats a recipe by id) and saves it as a recipe; description + tags make it easier to find
save_recipes → improves descriptions of several recipes at once; each description is embedded for search
```

Without a description, `execute` saves the recipe with Composio's generic tool description, so every step,
intermediate ones too, is found next time. The same tool + args is not saved twice. Failed calls are not recorded.
If a recipe stops matching its description, the agent saves it with `status: "outdated"` and says why.
Search then falls back to Composio again.

Good descriptions are general recipes, not one case:
`<Verb> <object> — TOOL_SLUG, args: {...}. Returns <what>. For another target override <args>.`
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
| `register_tool` | `{toolkit}` | `{toolkit, connect_url, connection_id}` — open the URL to connect the app |
| `login` | `{}` | `{user_id, connected: [{toolkit, status}]}` |
| `search` | `{query, limit?}` | `[{id, tool, args, description, summary, when, tags, status}]` |
| `execute` | `{tool, args}` or `{id, args?}`, optional `{description, tags}` | `{id, result, summary, saved?, note?}` |
| `save_recipes` | `{recipes: [{id, description, tags?, status?}]}` | `[{id, created_at, tags, description, status}]` |

```bash
genter register_tool '{"toolkit":"gmail"}'
genter search '{"query":"unread emails from today"}'
genter execute '{"tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread newer_than:1d"},
  "description":"Fetch unread emails — GMAIL_FETCH_EMAILS, args: {query, max_results?}. Returns a list of messages. For other filters override query.",
  "tags":["gmail","inbox","почта","письма"]}'
```

## Data

- Raw tool results are never stored, only a 1-3 sentence summary written by an LLM through OpenRouter
  (`SUMMARY_MODEL`, default `openai/gpt-4o-mini`). The same call with the same result is not saved twice.
- Every record (tool, args, description, summary, embedding) is encrypted with AES-256-GCM before it is stored.
  The store only sees `{id, remembered, blob}`. The CLI keeps its key in `~/.genter/config.json` and data in `~/.genter/calls.json`.

## Hosted MCP

The same tools run as a remote MCP server with OAuth (Google or email) in
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
