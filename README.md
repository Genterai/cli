# genter

Composio tools with memory. An AI agent finds a tool, runs it, and writes down what the call returned.
Next time `search` finds that ready-made call (tool + args), not just a raw tool.

```
search      → remembered calls first, Composio tools if memory has nothing valid
execute     → runs a tool (or repeats a call by id), returns {id, result}
add_memory  → describes call `id`; the description is embedded for search
```

If a remembered call stops matching its description, the agent adds a memory with `status: "outdated"` and says why.
Search then falls back to Composio again.

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
| `execute` | `{tool, args}` or `{id, args?}` | `{id, result}` |
| `add_memory` | `{id, description, tags?, status?}` | `{id, created_at, tags, description, status}` |

```bash
genter register_tool '{"toolkit":"gmail"}'
genter search '{"query":"unread emails from today"}'
genter execute '{"tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread newer_than:1d"}}'
genter add_memory '{"id":"<id>","description":"Unread emails from today","tags":["gmail","inbox"]}'
```

Calls and memories are stored in `~/.genter/calls.json`.

## Hosted MCP

The same tools run as a remote MCP server with OAuth (Google or email) in
[genter-backend](https://github.com/Genterai/genter-backend).

## Library

```js
import { createGenter } from "genter-cli";
import { tools } from "genter-cli/tools";

const genter = createGenter({ composioApiKey, openrouterApiKey, userId, store }); // store: get(id), put(record), all()
await genter.search({ query: "send a slack message" });
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for noncommercial use. Commercial use requires a separate license.
