# Agents working on genter-cli

The engine of Genter: Anchors, search, Genter's own agent, embeddings, freshness facts. It is a library the backend
imports (pinned by commit) and the `genter` command, which runs locally on the person's own Composio and OpenRouter keys.

## Specs come first

Behaviour lives in [Genterai/specs](<https://github.com/Genterai/specs>), usually checked out next to this repository as
`../specs`. Before changing anything a person, an API or MCP client could observe:

1. Find the specs of what you touch: `grep -rl "genter-cli:<path you touch>" ../specs --include=*.md` (every spec lists
   its code in its `code:` header), then read them.
2. If the change is an accepted statement (often marked `(planned)`), build it and name its full id.
3. If no statement covers it, or one says otherwise, open a spec pull request first (`governance/gap-protocol.md`).
   Never fill a gap silently in code.
4. Tag a test that verifies a statement with its full id in its name: `[spec:anchor-identity/deterministic-id]`.

Every PR that touches `src/` or `bin/` ends its description with one line (checked by
`.github/workflows/spec-check.yml`):

    Specs: implements <spec-id/statement-id>, <...>
    Specs: updated <link to the Genterai/specs pull request>
    Specs: none - <why no behaviour changes>

A change here reaches the hosted product only when genter-backend moves its pin to the new commit.

## Map

| Path | What lives there | Specs |
| -- | -- | -- |
| `src/genter.js`, `src/recipe.js` | Anchors: identity, execute, retrieval, areas, websites, skills | `anchors`, `anchor-identity`, `retrieval`, `areas`, `skills` |
| `src/drift.js` | freshness facts of a source | `anchor-drift`, `mcp` |
| `src/area.js` | listing and reconciling an area | `area-listing` |
| `src/agent.js`, `src/loop.js`, `src/tools.js`, `src/refs.js` | Genter's agent, MCP tool definitions, writes | `search-agent`, `mcp`, `writing` |
| `src/skills.js` | cutting a skill into pieces | `skill-pieces` |
| `src/web.js`, `src/net.js`, `src/mcp.js` | websites, public-address checks, MCP servers | `connectors`, `security` |
| `src/cost.js` | cost log events | `cost-observability` |
| `bin/genter.js` | the `genter` command | `cli` |
| `test/` | the tests | `testing`, `quality/guarantees/` |

## Commands

| Task | Command |
| -- | -- |
| install | `npm ci` |
| test | `npm test` |
| PR-line check | `node --test .github/scripts/spec-check.test.mjs` |
| run | `node bin/genter.js <command> '<json>'` (needs `COMPOSIO_API_KEY`, `OPENROUTER_API_KEY`) |

## Rules

- No app has its own Anchor workflow: fields are found by name; per-app read and write helpers are an open question in
  the specs (`what/writing.md`).
- A skill's files are never run: no `child_process`, `vm`, `eval`, `new Function` or `worker_threads`.
