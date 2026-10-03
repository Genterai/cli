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
write        → write where an answer's reference [n] (or a link) points: a file, an issue, a thread...

search       → saved recipes first, Composio tools if none is valid
execute      → runs a tool (or repeats a recipe by id) and saves it as a recipe; description + tags make it easier to find
save_recipes → improves descriptions of several recipes at once; each description is embedded for search
```

A recipe is one exact call with no parameters, named by its result: "Open pull requests of Genterai/genter-cli",
then what the result holds. Without a description, `execute` names it from the result itself (the same model call that
writes the summary), so every step, intermediate ones too, is found next time. The same tool + args is not saved twice.
Failed calls are not recorded. Dates in args can stay placeholders filled at each run: `{{today}}`, `{{tomorrow}}`,
`{{now}}`, `{{ago.7d}}`, `{{ahead.30d}}`.
If a recipe stops matching its description, the agent saves it with `status: "outdated"` and says why.
Search then falls back to Composio again.

Recipes are Markdown, named by the result of their call:

```md
### Unread emails in the inbox
Unread emails in the inbox, newest first: subject, sender, date and text.
`GMAIL_FETCH_EMAILS`
```

plus `short`, one line for compact lists (the Markdown is shown when a recipe is opened), and tags in English and Russian.
The MCP server sends these rules to clients as `instructions`.

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
| `search` | `{query, limit?}` | `[{id, tool, args, description, short, summary, when, tags, status}]` |
| `execute` | `{tool, args}` or `{id, args?}`, optional `{account, description, short, tags}` | `{id, result, summary, saved?, note?}` |
| `save_recipes` | `{recipes: [{id, description, short?, tags?, status?}]}` | `[{id, created_at, tags, description, short, status}]` |
| `disable_recipe` | `{id, disabled?}` | `{id, disabled}` — a disabled recipe stays saved but search and the agent skip it; `disabled: false` turns it back on |

```bash
genter register_tool '{"toolkit":"gmail"}'
genter search '{"query":"unread emails from today"}'
genter execute '{"tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread newer_than:1d"},
  "description":"### Fetch unread emails\n`GMAIL_FETCH_EMAILS` · args: `{query, max_results?}`\nReturns a list of messages. For other filters override `query`.",
  "short":"Fetch unread emails from the inbox",
  "tags":["gmail","inbox","почта","письма"]}'
```

## Agent

```bash
genter run '{"task":"reply to Anna\'s last email: Thursday 3pm works"}'
genter find '{"question":"what did Anna write about the contract?"}'
genter continue '{"run_id":"...","message":"use my work account"}'
```

A run ends `done`, `needs_input` (a question), `needs_connection` (a connect link) or `failed`; `continue` picks it up.
A `done` answer cites its sources as `[n]` and comes with `references` (see below).
`find` runs only tools that read (by Composio's hint or the verb in the slug). New calls are saved as recipes with
the agent's description, so the next run finds them. The model is `AGENT_MODEL` on OpenRouter, default `openai/gpt-oss-20b`.

```js
import { createAgent } from "genter-cli/agent";
import { agentTools, agentInstructions, agentResultText } from "genter-cli/tools"; // MCP definitions

const agent = createAgent({ genter, openrouterApiKey, secret, userId, runs }); // runs: get(id), put({id, blob})
const out = await agent.start({ task: "my meetings tomorrow", mode: "find" });
await agent.send({ run_id: out.run_id, message: "only the work calendar" });
```

## References and writes

Every answer says what it was built from. Each knowledge chunk, saved result, call result and item of a list the model
sees gets a number, the answer cites them as `[n]`, and the result lists the cited ones as `references`
(`src/refs.js`; `agentResultText` prints them under the answer):

```
Paging stops at the first page shorter than the page size [1].

References:
[1] github file Genterai/genter-cli/src/sync.js — https://github.com/Genterai/genter-cli/blob/main/src/sync.js
    where {"owner":"Genterai","repo":"genter-cli","path":"src/sync.js","branch":"main"}
    edit  {edits: [{find, replace}], message}: one commit, only those pieces change
    write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS(message, content)
```

`where` is what points to the place, named the way the app's write tools name it; `write` lists those tools with what
they still need. Synced items keep their `where` (the args of the list call that point somewhere, and the item's id
fields), so a knowledge hit knows its path, issue number, thread or task list. Popular apps have known write tools:
GitHub files, folders, issues, pull requests, repositories and commits, Gmail, Google Calendar, Google Tasks, Notion
pages. Any other app's are found in its own Composio catalogue (`genter.catalog`, cached for an hour): its tools that
change something (never delete, archive or bulk), ranked by how much of `where` they take. The item's id goes to its
kind's param (`issueId`, `idCard`, `issue_id_or_key`, `recordId`, `thread_ts`); the list call's args (a channel, a base
and a table) only where a tool requires them, so a filter of the list (`assignee: me`) is never written back; a tool
that needs the id of something else is left out.

`write` (MCP `GENTER_WRITE`, temporary) writes at a reference:

```bash
genter find '{"question":"when does paging stop in genter-cli?"}'
genter write '{"run_id":"...","ref":1,"change":"add a comment line on top: // Paging: see README"}'
genter write '{"run_id":"...","ref":1,"edits":[{"find":"const limit = 10;","replace":"const limit = 20;"}],"message":"Raise the limit"}'
genter write '{"run_id":"...","ref":3,"tool":"GMAIL_REPLY_TO_THREAD","args":{"message_body":"Thursday works"}}'
genter write '{"ref":"https://github.com/Genterai/genter-cli/issues/42","change":"comment: fixed in #43"}'
```

With `change`, the run goes on (it knows what it found, a find goes on as a run) with the place and its write tools,
args filled in, in front of the model. With `tool` + `args`, that exact call runs at once with the reference's args
under the given ones: no model step. A link works without a run: GitHub files, folders, issues, pull requests and
repositories, Notion pages, Gmail threads, Calendar events.

A file is changed by `edits`, not written out. An API commit always carries the whole new file (GitHub's contents and
git data APIs have no patch), but nobody has to type it: the file is read (its text and sha), each `{find, replace}`
replaces the one exact place it is at (`{append}` adds at the end, line endings are kept), and the result is committed
once with the sha it was read at. A `find` that is not there, or is there twice, commits nothing and names the lines
like it. `write` with `edits` + `message` does it with no model step; in a run the agent does the same with its
`edit_file` tool, never with the whole file. Neither the read nor the commit is saved as a recipe
(`execute({ remember: false })`).

A file is read with the agent's `read_file` tool (a reference number, or owner + repo + path + branch): its text, cut
at 20 000 characters, or a folder's entries, with a reference to cite and to edit. It is built in because tool search
does not surface it ("read file" finds READMEs and gists, not `GITHUB_GET_REPOSITORY_CONTENT`), so a task like "find the
recent commits, read their files, write a note" no longer stops at "there is no tool to read files". An answer that
gives up on a part for want of a tool is sent back once, on the strong model, to find the tool and do it.
`search_tools` always brings Composio tools (`search({ tools: true })`): a recipe that fits one part of a task (the
commits) no longer hides the tools of the others (`GITHUB_GET_A_COMMIT` for the files a commit changed).

### Test scenarios

`npm test` runs them with no keys: the model and the apps are stand-ins; the catalogues of the other apps are real
Composio schemas (`test/fixtures/catalogues.json`: Linear, Slack, Jira, Trello, Airtable, HubSpot, Notion).

| | scenario | what must hold |
| --- | --- | --- |
| S1–S4 | GitHub: a synced file, issue, pull request, repository; a file read live; links | path, link, `where`; the commit, comment or update tool with owner, repo, path or number filled; how the file is read and committed |
| E1–E3 | edits of a file | one exact place per `find`, `append`, CRLF kept; not found or found twice: nothing changes, lines like it are named |
| S5–S9 | Notion, Gmail (a list and synced mail), Calendar, Google Tasks | page id; thread and sender; calendar and event; task list and task |
| S10–S15 | Linear, Slack, Jira, Trello, Airtable, HubSpot, from their catalogues | the right tool and id param; a channel or base only in the list's args still lands; no delete, archive or bulk; list filters never written back |
| S16–S17 | an item of another kind, an unknown app | never the id of another kind; no hints and no error |
| S18 | citations | `[n]`, `[n, m]` in order; no marks: what the answer names, then the round's calls, then the closest knowledge |
| S19–S20 | sync | knowledge hits of a GitHub project and of Google Tasks lists carry part, item and `where` |
| A1–A3 | agent, GitHub | find → references → the agent sends only edits (`edit_file`), the file is read and committed once at its sha; `write` with edits and no model step; edits refused in a find; write at a link with no run |
| A4–A7 | agent, other apps | an exact Gmail reply with no model call; Linear through its catalogue; a catalogue too slow for the answer; an answer with no marks |
| R1–R5 | agent, reading files | `read_file` by owner, repo and path in a find: the text, a file reference, no recipe; a folder's entries; a missing file is an error; "no tool to read files" is sent back once on the strong model, never twice; a viewer cannot read |
| P1–P4 | agent, a task of several parts on a recipe of one | `search_tools` gets Composio tools even when a recipe fits; `read_file` with a commit's ref + path reads that path; `""` or the app's name is no account; an execute with no tool moves to the strong model; an empty ending is asked for the answer once |
| T1 | tool ranking | "the" and other empty words do not pull `..._FOR_THE_AUTHENTICATED_USER` tools up |
| G1–G2 | `genter.execute` itself (Composio answered over fetch) | a saved call returns its result and recipe id; `remember: false` saves nothing |
| A8–A10 | refused | a number without its run, an unknown number, a tool of another app, a viewer; `GENTER_WRITE` only where writing is on |

## Ready recipes

Popular apps get their recipes the moment an account is connected, with no model and no sample calls (`src/ready.js`,
`setup_recipes`): GitHub lists the account's repositories once and makes a **sync recipe per repository** (the whole
project: its description, every file on the default branch, every issue and pull request) plus reads such as
"Issues and pull requests assigned to me" and "Recent commits of <repo>"; Gmail, Google Calendar, Google Tasks and Notion
get a sync recipe for the account and everyday reads ("Unread emails in the inbox", "Today's events"). Each read runs
once, so its result is known. Making them again updates the same recipes. Other apps get reads planned by a model from
the app's read tools in one call (`builder.intents`), run once each.

```bash
genter setup_recipes '{"toolkit":"github"}'
genter live_sync '{"id":"sync_...","once":true}'   # Run now: keep the whole project as embeddings
genter knowledge '{"query":"how are recipes deduplicated?"}'
```

A first sync of a repository downloads its archive once (`bulk`) instead of reading files one by one, and embeds chunks
in batches; later syncs read only changed files and list issues `{{since}}` the last one. A sync cut short continues
on the next call or the scheduler a minute later.

## Sources

A source keeps an app's content as searchable knowledge: the files of a GitHub repo, the pages shared with Genter in Notion.
The agent sees the closest chunks before its first step, so a question about a repo is answered from it right away.

```bash
genter add_source '{"template":"github","scope":{"owner":"Genterai","repo":"genter-cli"},"depth":"full"}'
genter sync_source '{"id":"src_..."}'
genter knowledge '{"query":"how are recipes deduplicated?"}'
genter run '{"task":"remember the Notion pages about the roadmap, summaries only"}'
```

The sync engine knows no connector. A **live sync recipe** (plain JSON, `src/sync.js`) maps an app's tools onto roles:
`list` (pages of items with an id and a version), `read` (an item's text), and optional `choices` (what the user can pick:
their repos, top-level pages), `setup` (fills scope fields, e.g. the default branch) and `triggers` (Composio events that
mean "changed"; an event syncs the source). GitHub files and Notion pages are built in. For anything else the agent's
`build_live_sync` runs a builder (`src/builder.js`, `BUILDER_MODEL`, default `openai/gpt-6-luna`) that explores the app's
tools with real sample calls, writes the recipe, tests it on real data (`test_live_sync`) and saves it like any recipe
(`save_live_sync`), so it is found by search and reused:

```bash
genter run '{"task":"remember all pull requests of Genterai/genter-backend and keep them up to date"}'
```

A recipe can have `parts` (several lists: files, issues, description), fixed `vars` instead of scope fields (so it has
no parameters), `fields` (an item as plain text of these paths) and a list given only as a call: its items, ids,
versions and pages are found in the first real response.

Each source has its own filters for any app: `include` / `exclude` regexes over id and title, `maxItems`.
Triggers need a webhook receiver, so they are on only where `createGenter` gets `triggers: true` (the hosted backend).
A sync lists everything, reads only the items whose version changed and drops the ones that are gone: the first sync
is a full one, every next one is incremental, and a sync cut short by its time budget continues next time.

| depth | what is kept | cost |
| --- | --- | --- |
| `titles` | names, paths and links; nothing is read | one list call per page |
| `summary` | a 2-4 sentence summary per item | a read and a model call per changed item |
| `full` | the whole text in chunks (default) | a read and embeddings per changed item |

Changing the depth re-processes the items on the next sync. Chunks are encrypted like everything else.
Limits: 10000 items and 100 list pages per source, 80 chunks per item; GitHub skips binaries, lockfiles, `node_modules`
and files over 300 KB.

## Data

- Raw tool results are never stored, only a 1-3 sentence summary written by an LLM through OpenRouter
  (`SUMMARY_MODEL`, default `openai/gpt-oss-20b`). The same call with the same result is not saved twice.
- Every record (tool, args, description, summary, embedding) is encrypted with AES-256-GCM before it is stored.
  The store only sees `{id, remembered, blob}`. The CLI keeps its key in `~/.genter/config.json` and data in `~/.genter/calls.json`.
- Agent runs are encrypted the same way (`~/.genter/runs.json`). Tool results in them are replaced by their summaries
  before they are stored; a follow-up re-runs the recipe when it needs details.

## Hosted MCP

The agent tools (`GENTER_RUN_TASK`, `GENTER_FIND`, `GENTER_CONTINUE_TASK`, and for now `GENTER_WRITE`) run as a remote MCP server with OAuth (Google or email) in
[genter-backend](https://github.com/Genterai/genter-backend).

## Library

```js
import { createGenter } from "genter-cli";
import { tools } from "genter-cli/tools";

const genter = createGenter({ composioApiKey, openrouterApiKey, userId, secret, store, knowledge }); // store: get(id), put(row), all()
// knowledge (optional, for sources): getSource, putSource, deleteSource, sources, items, putItems, deleteItems, allItems
// onSync(source, { reason }) (optional): called after every sync run (manual, trigger, schedule, live), e.g. to log it
await genter.search({ query: "send a slack message" });
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for noncommercial use. Commercial use requires a separate license.
