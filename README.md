# genter

Composio tools with saved call anchors. An AI agent finds a tool and runs it; every successful call is remembered as an **Anchor**.

> An anchor is one successful tool call with fixed, concrete arguments, plus what it actually returned.
> Semantic memory finds the right call again; the real call is re-executed to keep data current, and the Anchor
> changes only when its result changes.

An anchor is not a workflow, a chain or a sync job: an agent that makes 15 calls makes up to 15 Anchors. Orchestration,
fan-out and reasoning belong to the agent.

```
run          → the agent does a task in your apps
find         → read-only agent: picks the calls from memory, reads live data
continue     → answer a run's question or give a follow-up
write        → write where an answer's reference [n] (or a link) points: a file, an issue, a thread...

search       → which saved call to make (by what its result meant), Composio tools if none fits
execute      → runs the REAL tool (or repeats an anchor by id) and saves / updates its anchor
anchors      → list saved anchors; recheck_recipe runs one again; remove_recipe deletes it
```

**Identity.** `id = "rcp_" + sha256(workspaceId | account | tool | canonicalArgs)[0..24]` (`src/recipe.js`). The same call
upserts the same Anchor; two connected accounts never share one. Dates in args stay placeholders filled at each run:
`{{today}}`, `{{tomorrow}}`, `{{now}}`, `{{ago.7d}}`, `{{ahead.30d}}`.

**Execute.** The tool always runs. A failed call creates nothing (a known anchor whose error says "not found" is marked
`gone`, "forbidden / revoked" `denied`; neither is found by search again). A successful result is hashed
(`contentHash`: volatile keys dropped, base64 file content decoded, whitespace normalized):

- no anchor yet: it is described (title, short, a semantic summary, one line per item, search keywords) and embedded;
- same hash: nothing is described or embedded, only `checked_at` moves;
- other hash: the same anchor is described and embedded again (`updated_at` = when the result last changed).

A result that is a page or cut off (next-page token, `has_more`, `truncated`) is marked `partial`; its summary only claims
what was returned. Retrieval embeds the result summary (with its keywords: the app, the kind of thing, synonyms and names, in English and
in the data's language, so "почта" finds "Unread emails from today") and items, never the tool's description. A request that names a
site the workspace reads ("Evallens" for evallens.io) gets that site's closest pages first, up to half the places, whatever their
score by meaning; the tool search still runs. An anchor's summary says which call to make, not the current value: the agent always executes again.

Anchor record (stored encrypted, raw results never): `{id, tool, args, scope:{account, toolkit, area?}, title, short, summary, items,
keywords, digest, partial, source:{app, path[], url}, created_at, updated_at, checked_at, status: fresh|stale|gone|denied,
trigger:{active, spec, id}}`. Records of the older model (`memory`, `alias`, `kind: "sync"`) are normalized on read.

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
| `register_tool` | `{toolkit, alias?}` or `{mcp_url, name?, api_key_header?}` | `{toolkit, connect_url, connection_id}` — open the URL to connect the app; an app can be connected several times. `mcp_url`: any remote MCP server, added to Composio as a custom toolkit (`custom_mcp_<name>_<hash>`, one per address); how it signs in (none, OAuth with client registration, an API key) is asked of the server, and one with no sign-in answers `no_auth: true` and no URL |
| `login` | `{}` | `{user_id, connected: [{toolkit, account, alias, status}]}` |
| `search` | `{query, limit?}` | `[{id, tool, args, title, short, summary, keywords?, matched?, score, status, updated_at, checked_at, trigger:{active}}]` (fresh anchors only), then Composio tools (`id: null`) |
| `execute` | `{tool, args}` or `{id, args?}`, optional `{account}` | `{id, result, created, changed, unchanged, recipe_status}` |
| `recipes` | `{}` | every anchor without vectors |
| `recheck_recipe` | `{id}` | `{recipe, changed, status}` |
| `remove_recipe` | `{id}` | `{id, removed}` |

```bash
genter register_tool '{"toolkit":"gmail"}'
genter register_tool '{"mcp_url":"https://mcp.deepwiki.com/mcp","name":"DeepWiki"}'
genter search '{"query":"unread emails from today"}'
genter execute '{"tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread newer_than:1d"}}'
genter anchors '{}'
```

## Agent

```bash
genter run '{"task":"reply to Anna\'s last email: Thursday 3pm works"}'
genter find '{"question":"what did Anna write about the contract?"}'
genter continue '{"run_id":"...","message":"use my work account"}'
```

Over MCP, `GENTER_FIND` takes `{question, account?, goal?, conversation_id?, model?}`. `goal` is optional: what the task is for, in a few words
(`"writing product documentation"`), while `question` stays what to find. `goal` only brings the user's matching skills and
guides, in a separate "Skills for the goal" section of the result (`skills` in its JSON line) after the data anchors; they
never take a slot of the data anchors, and a skill shown once is not shown again in the same chat. `conversation_id` is an optional short id the client's model makes up once per chat (the same in every call of the chat, new in a new chat): skills are not repeated per that id (kept apart per person and workspace; without it, per MCP session). `model` is the client's model name, for the call log only. Without `goal` nothing changes.

A run ends `done`, `needs_input` (a question), `needs_connection` (a connect link) or `failed`; `continue` picks it up.
A `done` answer cites its sources as `[n]` and comes with `references` (see below).
`find` runs only tools that read (by Composio's hint or the verb in the slug). Every successful call is saved as an anchor
automatically; each step of the result says `recipe: {id, created, changed}` and the result lists `saved` and `recipes_used`.
Each reference names the anchor whose call showed it (`recipe`), and a `done` result lists `answer_recipes`: the anchors its
references came from (mode `recipes`: those handed over), not the calls made only to find a name or an id. The request is
kept on those anchors, and only on them, once the run is done (`genter.recipes.asked({ ids, task })`: its vector, and a
skill's piece takes it as an intent), so the same request, or one close to it, finds all of them again (modes `run`, `find`,
`recipes`; a `prepare` or `event` task is an instruction and is kept nowhere). The model is `AGENT_MODEL` on OpenRouter, default `openai/gpt-oss-120b` (see Models).
The agent is offered only tools of connected apps (`genter.search({ connected: true })`), and a call gpt-oss writes as
text instead of making it (its harmony channels came back unparsed) is made as a call, never shown as the answer.
An answer that falls into a loop (gpt-oss at temperature 0 now and then writes one piece until its token limit:
"…либо учебником, как-то-как-как-как-…") is never shown either: it is written again once at temperature 1, told where
it looped, and cut where the loop starts if it loops again (`genter-cli/loop`). A model call writes at most
`AGENT_MAX_TOKENS` (16384), so a loop ends in seconds.

```js
import { createAgent } from "genter-cli/agent";
import { agentTools, agentInstructions, agentResultText } from "genter-cli/tools"; // MCP definitions

const agent = createAgent({ genter, openrouterApiKey, secret, userId, runs }); // runs: get(id), put({id, blob})
// modes: "run", "find" (read-only), "recipes" (read-only, no written answer: finds and runs the calls that hold what was
// asked, and the result's `results` are those anchors' raw results), "prepare" (list an area, read every item with
// read_each / read_many, finish with counts), "event" (task text carries the event and the affected anchors: recheck_recipe / forget_recipe)
const out = await agent.start({ task: "my meetings tomorrow", mode: "find" });
await agent.send({ run_id: out.run_id, message: "only the work calendar" });
```

Mode `recipes` is what the hosted MCP server's `GENTER_FIND` runs when no saved anchor fits the question well enough to
run it directly: the model writes no answer. It runs the saved anchors that fit or finds new calls (each success is an
anchor, `read_file` included), and ends with the ids of the ones whose results hold the answer; the result carries them as
`results: [{ id, tool, args, from?, account?, created, changed, instructions?, data }]` (at most 8, the data as the call
returned it, items with `_ref`; kept in memory only, never in the stored run), and `references` are theirs. A named anchor
not run in this round is run then. None named: every result of the round that held something. `recipesResultText(out,
{ write, instructions })` (`genter-cli/tools`) is the MCP text of it: each result under a line naming its call (base64 file
contents decoded), References, a JSON line.

`instructions` (optional) is what a workspace admin wrote for this person: tone, language, defaults, what to stay away
from. It goes to the model as a second system message in every call, after the fixed prompt (which stays cacheable).
It shapes the work; it never changes which tools may run (`canExecute`, the connectors the `genter` client allows).

## Models

Every model call (the agent, result summaries, query translation) uses `openai/gpt-oss-120b` on OpenRouter, the
provider that answers first (`OPENROUTER_SORT=latency`). Set `AGENT_MODEL`, `AGENT_STRONG_MODEL`, `SUMMARY_MODEL`,
`QUERY_MODEL` to change one. Chosen on Genter's own tasks (October 2026), 7 checks per run:

- translate "когда мне убираться" to `{en, terms}` within 6 s;
- summarize 40 calendar events so the one named «Уборка» is found by that request;
- not keep a GitHub notification ("clean up") as an anchor for it;
- the agent, twice: answer it from an anchor whose result held the event; list Google Tasks across two lists.

| model | checks passed | agent answer | summary | the 7 checks cost |
|---|---|---|---|---|
| `openai/gpt-oss-120b`, latency | 34/35 (5 runs; 21/21 since a close line keeps a result) | 1.0–1.7 s | 2.7–8.3 s | $0.0024 |
| `openai/gpt-oss-120b`, throughput | 20/21 (3 runs) | 0.6–1.0 s | 2.0–2.8 s | $0.0152 |
| `google/gemini-3.5-flash-lite` | 20/21 | 1.2–3.0 s | 3.3–3.7 s | $0.0173 |
| `openai/gpt-5.4-nano` | 20/21 | 2.4–6.3 s | 5.4–7.9 s | $0.0057 |
| `openai/gpt-6-luna` | 20/21 | 2.7–6.0 s | 8.0–13.1 s | $0.0025 |
| `openai/gpt-oss-20b` | 18/21: keeps the notification every time | 0.4–8.4 s | 2.9–4.1 s | $0.0029 |
| `google/gemma-4-31b-it` | 5/7: translation and summary time out | 7.2–8.7 s | 62 s | $0.0235 |

Cheaper ones (`inclusionai/ling-3.0-flash`, `qwen/qwen3.7-flash`, `deepseek/deepseek-v4-flash`, `inception/mercury-2.5`)
miss the 6 s translation or the summary, and `gpt-oss-120b` sorted by price breaks its JSON. Trigger recommendation
keeps `BUILDER_MODEL` (default `google/gemma-4-31b-it`).

## References and writes

Every answer says what it was built from. Each knowledge chunk, saved result, call result and item of a list the model
sees gets a number, the answer cites them as `[n]`, and the result lists the cited ones as `references`
(`src/refs.js`; `agentResultText` prints them under the answer):

```
Paging stops at the first page shorter than the page size [1].

References:
[1] github file Genterai/genter-cli/src/sync.js — https://github.com/Genterai/genter-cli/blob/main/src/sync.js
    where {"owner":"Genterai","repo":"genter-cli","path":"src/sync.js","branch":"main"}
    read  GENTER_FIND {"question":"Read the github file \"Genterai/genter-cli/src/sync.js\" in full: https://github.com/Genterai/genter-cli/blob/main/src/sync.js"}
    edit  {edits: [{find, replace}], message}: one commit, only those pieces change
    write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS(message, content)
```

`read` is the follow-up a client's model makes to read the place in full (`readQuestion`: an email's body, a whole file, a
skill's section, a page; as Search asks when a source is clicked); GENTER_FIND's raw results give it to the items of a list,
not to a result that is one source (it is there in full). `where` is what points to the place, named the way the app's write tools name it; `write` lists those tools with what
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

The text a write puts somewhere is the caller's, never the agent's: `change` carries the exact text and where it goes
(the agent is told to put it there word for word and write nothing of its own), `edits` the exact pieces and the new text.
With `change`, the run goes on (it knows what it found, a find goes on as a run) with the place and its write tools,
args filled in, in front of the model. With `tool` + `args`, that exact call runs at once with the reference's args
under the given ones: no model step. A link works without a run: GitHub files, folders, issues, pull requests and
repositories, Notion pages, Gmail threads, Calendar events.

A file is changed by `edits`, not written out. An API commit always carries the whole new file (GitHub's contents and
git data APIs have no patch), but nobody has to type it: the file is read (its text and sha), each `{find, replace}`
replaces the one exact place it is at (`{append}` adds at the end, line endings are kept), and the result is committed
once with the sha it was read at. A `find` that is not there, or is there twice, commits nothing and names the lines
like it. `write` with `edits` + `message` does it with no model step; in a run the agent does the same with its
`edit_file` tool, never with the whole file. Neither the read nor the commit is saved as an anchor
(`execute({ remember: false })`).

A file is read with the agent's `read_file` tool (a reference number, or owner + repo + path + branch): its text, cut
at 20 000 characters, or a folder's entries, with a reference to cite and to edit. It is built in because tool search
does not surface it ("read file" finds READMEs and gists, not `GITHUB_GET_REPOSITORY_CONTENT`), so a task like "find the
recent commits, read their files, write a note" no longer stops at "there is no tool to read files". An answer that
gives up on a part for want of a tool is sent back once, on the strong model, to find the tool and do it.
`search_tools` always brings Composio tools (`search({ tools: true })`): an anchor that fits one part of a task (the
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
| R1–R5 | agent, reading files | `read_file` by owner, repo and path in a find: the text, a file reference, no anchor; a folder's entries; a missing file is an error; "no tool to read files" is sent back once on the strong model, never twice; a viewer cannot read |
| P1–P4 | agent, a task of several parts on an anchor of one | `search_tools` gets Composio tools even when an anchor fits; `read_file` with a commit's ref + path reads that path; `""` or the app's name is no account; an execute with no tool moves to the strong model; an empty ending is asked for the answer once |
| T1 | tool ranking | "the" and other empty words do not pull `..._FOR_THE_AUTHENTICATED_USER` tools up |
| R1–R3 (answer's anchors) | the anchors an answer rests on | references carry `recipe`; `answer_recipes` are the cited ones (mode `recipes`: those handed over) and only they keep the request; a prepare keeps none |
| N1 | no answer | an empty ending is asked once on the strong model; empty again is a failure naming what ran, never "Done." with references |
| G1–G2, G4–G5 | `genter.execute` itself (Composio answered over fetch) | a saved call returns its result and a deterministic id; `remember: false` saves nothing; a line of a result finds its anchor |
| R1–R10 | anchors | one record per call whatever the arg order; an unchanged result calls no model and only bumps `checked_at`; a changed one regenerates the same anchor; a failed call creates nothing; gone / denied are never offered; two accounts, two anchors; partial pages; recheck, triggers, scopes; recheck never runs again a call that changes something (a saved send is not sent again) |
| N2–N7 | anchors in the agent | `recipe: {id, created, changed}` on steps, `saved`, `recipes_used`; the prompt (no tool name begins with another's, free-form args have no type); `suggest_prepare`; `read_many` and `read_each` in a prepare task (every listed file, folders and binaries left out; called through execute too; args as JSON text; the run's `listing`); event tasks |
| R1–R3 (reconcile) | an area kept whole (`genter.recipes.reconcile`) | a new file gets its anchor, a changed sha is checked again, a removed file is gone and comes back fresh, a deleted anchor stays deleted, an image is never read; a budget with the rest pending; a read that keeps failing is given up; a failed or empty list touches nothing, a cut one marks nothing gone; `inArea` |
| recipe.test.js | pure `src/recipe.js` | canonical args, ids, content hash, partial detection, failure classes, provenance, legacy records |
| C1–C4 | the agent's tool search (`connected: true`) | only tools of connected apps: "What's on my calendar today" gets Google Calendar's, never another app's calendar tool (Clarify); an app meant by a word ("calendar", "meetings", "drive"); without `connected` Composio's search over all apps is as before |
| H1–H4 | gpt-oss calls as text | a call written as harmony text (`to=functions.execute json{…}`) is made, not shown; the final channel is the answer, reasoning alone is sent back once then fails; a slug called as a function is an execute; a tool of an app that is not connected names the connected apps and their tools |
| L1–L3, loop.test.js | an answer that falls into a loop | written again once (temperature 1, told the piece it repeated, the loop not sent back); looping again, cut where it starts; all loop: asked for the answer; tables, code rules and short repeats are no loop |
| A8–A10 | refused | a number without its run, an unknown number, a tool of another app, a viewer; `GENTER_WRITE` only where writing is on |
| R1–R7 | read-only MCP (`readOnly`) | without actions the MCP tools are `GENTER_FIND` and `GENTER_CONTINUE_TASK`, and every description says Genter finds and the client writes; a read-only agent runs a task as a find, refuses `write()`, continues a run started elsewhere read-only; a read-only run looks up an anchor id it did not meet before running it (a saved send does not run) and refuses a tool its mode does not offer (`recheck_recipe` outside an event); a write's change goes there word for word |

## Preparing an area, triggers

If the agent finds a finite area (a repository's files, a Drive folder, a channel) it calls `suggest_prepare({label, why})`
(no side effects; the result carries `suggestions: [{label}]`). A `prepare` run lists the area with the app's list tool
(a repository: its whole tree) and then calls `read_each {list_id, read_tool, shared_args, item_arg}`: the engine makes
one read per item that list call listed (`shared_args` plus the item's value in `item_arg`, e.g. `path`; folders and
files with no text, images, archives, lock files, left out; 4 at a time, up to 300), so the model never writes the calls
out (it cut a hundred short, and saw a long tree only in part). `read_many` takes calls the model writes itself (up to 100).
Each success is an ordinary atomic anchor. `genter.recipes.prepareScope` keeps a minimal area record in the optional
`scopes` store so events know the area was prepared.

**Keeping an area whole** (`src/area.js`). A prepare run hands over how it read the area, `listing = {recipe_id, tool, args,
account, read_tool, shared_args, item_arg, item_field, versions}`: the list call's anchor, the read each item got, and every
item read with the version the list gave it (a tree's `sha`, a modified time; `""` with none). The host keeps it with the
area. `genter.recipes.reconcile({listing, budget = 40})` compares the area with its anchors with no model: the list call
runs again (the real call), and an item with no anchor yet is read (a new anchor), one whose version moved or whose anchor is
`gone`/`stale` is checked again, one no longer listed is marked `gone` (no call; not when the list was cut), and one read
before whose anchor is no longer there (a person deleted or forgot it) is left out. At most `budget` calls, new items first;
the rest is `pending` for the next time; a read that failed 3 times is given up. An area's anchors are known by their id
(the read's call: `itemId`), never by guessing. It answers `{status, listing (to keep), created, changed, gone, unchanged,
pending, failed, excluded, listed, partial}`. `genter.recipes.inArea({listing, ids})` tells which anchors are the area's reads.

Two things about gpt-oss on Groq (the quickest provider, OpenRouter's pick by latency) shape the tool list: no tool's name
begins with another's (`execute_many` came out as `execute<|channel|>...` and Groq refused the call: hence `read_many`,
`read_each`; the old names are still understood), and a free-form `args` has no `type` (Groq wrote an object with no
listed properties as `{}`, so calls went out without their args). A call of one of the agent's own tools written as
`execute {tool: "read_each", args}` is that tool.

Every anchor knows the area its call reads in, `scope.area = {id, label, kind, where}` (`areaOf` in `src/recipe.js`): the
container its args name (`owner` + `repo` is a repository, `calendarId` a calendar, `channel` a channel, `folder_id` a
folder...), else the one folder every item of its result sits in (Drive's `parents`); none for a call over the whole app.
Arg and field names only, no connector code. The hosted backend uses it to offer a project for that area.

**Websites** need no app. `prepare_website({url, depth?})` is a prepared area: a local crawl (`src/web.js`) finds the
address and the pages it links to on the same site, up to two links deep (at most 120 pages, robots.txt respected,
public addresses only), and each page is read by the local tool `WEBSITE_READ_PAGE {url}` as an ordinary anchor. Run it
again (the hosted backend does, every hour): an unchanged page only moves `checked_at`, a changed one is described again,
a new one is added, a page the site removed (404) is marked gone. `forget_website({url})` drops the site's anchors.

A trigger keeps an anchor current: `recipes.recommendTrigger(id)` lets a model pick a Composio trigger spec for the
anchor's app (cached in `trigger.spec`), `recipes.setTrigger({id, active})` creates or disables it (only where
`createGenter` gets `triggers: true`, the hosted backend), `recipes.byTrigger({triggerId})` finds the anchors an event
concerns; the backend wakes the agent in `event` mode with them. `recipes.setTriggers({ids, active})` does it for many
anchors at once (a project's Keep in sync): each anchor keeps its own trigger, the spec picked for its own call, and
anchors whose specs are the same subscription (slug, config, account) share one Composio trigger, so one event wakes one
run with all of them; a shared trigger is disabled only when no anchor keeps it on. When an anchor's result changes, the
record keeps `previous` (`{title, short, summary, items, updated_at}` of the result before), so a notification can say
what changed.

## Data

- Raw tool results are never stored, only a digest, a semantic summary and item lines written by an LLM through OpenRouter
  (`SUMMARY_MODEL`, default `openai/gpt-oss-120b`). The same call upserts the same anchor; an unchanged result is not described again.
- Every record (tool, args, summary, items, embeddings) is encrypted with AES-256-GCM before it is stored.
  The store only sees `{id, remembered, blob}`. The CLI keeps its key in `~/.genter/config.json` and data in `~/.genter/calls.json`.
- Agent runs are encrypted the same way (`~/.genter/runs.json`). Tool results in them are replaced by their summaries
  before they are stored; a follow-up re-runs the anchor when it needs details.

## Hosted MCP

The agent tools run as a remote MCP server with OAuth (Google or email) in
[genter-backend](https://github.com/Genterai/genter-backend). Genter finds; the client's own model thinks and writes:
`agentTools()` is `GENTER_FIND` and `GENTER_CONTINUE_TASK` (read-only), and `agentTools({ actions: true })` adds
`GENTER_RUN_TASK` and `GENTER_WRITE`, which carry out an action the client has decided, with the exact text it wrote
(`agentInstructions`, plus `actionInstructions` where actions are on). `createAgent({ readOnly: true })` is the agent
behind the read-only tools: every run is a find, a run continued there goes on as one, `write()` refuses.

## Library

```js
import { createGenter } from "genter-cli";
import { tools } from "genter-cli/tools";

const genter = createGenter({ composioApiKey, openrouterApiKey, userId, secret, store }); // store: get(id), put(row), all(), remove?(id)
// workspaceId (default userId), scopes (get/put/list/remove), triggers: true, allow(record), defer(promise)
await genter.register_tool({ mcp_url: "https://mcp.example.com/mcp" }); // or { toolkit }; prepare_website({ url }), forget_website({ url })
await genter.search({ query: "send a slack message" });
const out = await genter.execute({ tool: "GMAIL_FETCH_EMAILS", args: { query: "is:unread" } }); // { id, result, created, changed, unchanged, pending }
await genter.recipes.list(); // get(id), remove(id), recheck(id), invalidateAccount({account|toolkit}), markGone(id),
                             // recommendTrigger(id), setTrigger({id, active}), setTriggers({ids, active}), byTrigger({triggerId}),
                             // reconcile({listing, budget}), inArea({listing, ids}), prepareScope(...), scopes()
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for noncommercial use. Commercial use requires a separate license.
