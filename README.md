# genter

Composio tools with saved call recipes. An AI agent finds a tool, runs it, and saves a recipe: what the call does and with which args.
Next time `search` finds that ready-made call (tool + args), not just a raw tool.

```
search       → saved recipes first, Composio tools if none is valid
execute      → runs a tool (or repeats a recipe by id); with description + tags it saves the recipe right away
save_recipe  → describes call `id`; the description is embedded for search
```

If `execute` gets no description, its `next` field holds a draft `save_recipe` call to fill in.
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
| `search` | `{query, limit?}` | `[{id, tool, args, tags, description, status}]` |
| `execute` | `{tool, args}` or `{id, args?}`, optional `{description, tags}` | `{id, result, saved}` or `{id, result, next}` |
| `save_recipe` | `{id, description, tags?, status?}` | `{id, created_at, tags, description, status}` |

```bash
genter register_tool '{"toolkit":"gmail"}'
genter search '{"query":"unread emails from today"}'
genter execute '{"tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread newer_than:1d"},
  "description":"Fetch unread emails — GMAIL_FETCH_EMAILS, args: {query, max_results?}. Returns a list of messages. For other filters override query.",
  "tags":["gmail","inbox","почта","письма"]}'
```

## Data

- Tool results are never stored. The recipe the agent writes is the result.
- Calls without a recipe are deleted after one hour.
- Every record (tool, args, description, embedding) is encrypted with AES-256-GCM before it is stored.
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
