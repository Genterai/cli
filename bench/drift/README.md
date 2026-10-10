# DriftBench

DriftBench measures whether a memory or retrieval system for AI agents returns **current** facts after the documents it
was given have changed, when nobody tells it what changed. The same questions are asked twice: once against the
documents as they were first added (t0), and once after two months of ordinary edits (t1): values changed in place,
sections moved to other files, pages replaced by newer pages, pages deleted, new pages added.

A system scores well when, at t1, it returns the new answer, does not return an answer that is no longer true as if it
were current, and still finds the facts that did not change.

## Dataset

| Path | What it is |
| --- | --- |
| `corpus/` | The t0 state: 34 internal docs of Northwind Labs, a fictional 40-person company that sells Beacon, a hosted uptime-monitoring service (handbook, engineering, ops, product, sales, security, support) |
| `changes.json` | The edits that turn t0 into t1, applied in order |
| `questions.json` | 65 questions, each with its answer at t0 and at t1 and the file that holds it |
| `check.mjs` | Validates all of the above; exports `applyChanges(dir, changes)` for runners |

The corpus is written with distractors on purpose: near-duplicate pages (production and staging deploys, EU and US
on-call, Postgres and backups, monitoring and alerting, data retention and plan history) hold similar facts with
different values.

### Changes

```json
{"op": "edit", "file": "ops/database.md", "find": "<exact text, occurs once>", "replace": "<new text>"}
{"op": "add", "file": "ops/alerting.md", "text": "<whole file>"}
{"op": "delete", "file": "sales/q3-promo.md"}
{"op": "move", "from": "handbook/travel.md", "to": "handbook/policies/travel.md"}
{"op": "prepend", "file": "ops/incident-response.md", "text": "> **Deprecated:** replaced by [Incident management](incident-management.md)\n\n"}
```

`find` must occur exactly once in the file when the edit applies. Paths are relative to the corpus root.

### Questions

```json
{"id": "q16", "kind": "update", "question": "Which port does the staging Postgres pooler listen on?",
 "t0": "6432", "t1": "5433", "file_t0": "ops/database.md", "file_t1": "ops/database.md"}
```

`t0` and `t1` are short, distinctive strings that appear verbatim in the doc (a port, a version, a channel, a name). A
`null` answer means the fact does not exist in that state.

## Kinds

| Kind | Count | What happens between t0 and t1 |
| --- | --- | --- |
| `stable` | 15 | Nothing; same answer, same file |
| `update` | 16 | The value is edited in place in the same file |
| `moved` | 6 | The fact's section moves to another file (a `move` op, or cut from one file and added to another); the value may change too |
| `deprecated` | 5 | The old doc gets a deprecation notice on its first line and keeps its old text; a new doc added at t1 holds the new value |
| `deleted` | 4 | The doc is deleted and nothing replaces it; `t1` is `null`, and the right outcome is not returning `t0` as current |
| `new` | 5 | The fact appears only in a doc added at t1; `t0` is `null` |
| `paraphrase` | 8 | Stable, but the question shares no rare words with the doc |
| `crosslingual` | 6 | Stable, but the question is in Russian and the doc in English |

## Matching

An answer matches a text when it is a case-insensitive substring of it after collapsing all whitespace to single spaces
(`normalize` and `contains` in `check.mjs`). The check guarantees that matching cannot succeed by accident:

- each non-null answer occurs in exactly one file of its state, the one named by `file_t0` or `file_t1`;
- for `update`, `moved`, `deleted` and `deprecated`, the old answer occurs nowhere at t1, except below the notice in the
  deprecated doc;
- for `update`, `moved`, `new` and `deprecated`, the new answer occurs nowhere at t0.

So a retrieved passage at t1 that contains `t1` is current, and one that contains `t0` (outside a passage marked as
replaced) is stale.

## Checking the dataset

```bash
node bench/drift/check.mjs
```

It applies `changes.json` to a temporary copy of `corpus/`, checks every change and every question against both states,
prints the file counts and the questions per kind, and exits with 1 and one line per problem if anything is off.

## Running it

```bash
npm run bench                                   # no key, no network, no install: about 30 seconds
AI_GATEWAY_API_KEY=... npm run bench -- --semantic          # + both with embeddings (text-embedding-3-small)
AI_GATEWAY_API_KEY=... npm run bench -- --semantic --answer # + a model answers from each arm's passages
```

Any provider of `--semantic` works (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, Ollama). `--out
results.json` keeps the numbers, `--md report.md` the full report, `--readme` writes the tables into the README, and
`--guard README.md` fails the run when genter does worse than the README says (what the weekly run in
`.github/workflows/bench.yml` does).

The arms:

| Arm | What it is |
| --- | --- |
| `genter` | `genter add` at t0, `genter ask` for every question at t0 and t1, words only |
| an index built once | the same sections and the same ranking, over the text kept at t0: any index nobody rebuilds |
| `genter --semantic`, an index built once + vectors | the same two with embeddings fused in |
| an index re-synced every 15 / 60 minutes | genter's own search over a copy of the docs taken every 15 or 60 minutes (below) |
| a memory that extracts facts with a model | a memory library with its default models, given every section at t0 with fact extraction on |
| the same memory, every edited file added again | the same, after every file the edits touched had its memories deleted and was added again from t1 |

### Over time

The edits also land one by one, 2 to 30 minutes apart, at times drawn from a seeded generator (5 timelines by default,
`--seeds N`). Each of the 36 facts the edits change is asked again 1, 5, 15, 30, 60 and 120 minutes after the edit that
made its current answer, of genter (the live folder, read at that moment) and of an index re-synced every 15 and every
60 minutes since the docs went in (genter's own search over the copy taken at the last re-sync: the same ranking, so only
freshness differs). The report shows the current and the stale share at each of those times.

### What it takes

`node bench/drift/takes.mjs` (and every run) measures it on the machine that runs it: packages installed with
genter-cli (from `package.json` and the lockfile), the time from a cold `genter add` of the docs to the first `genter ask`
in new processes with no key in their environment, every network connection, name lookup and server those processes
start (`net-count.mjs`, preloaded), the median of the 65 searches, and what the store keeps: it is opened with its secret
and searched for every line of the docs.

### The memory that extracts facts

It runs in Python on its own. The exact package, its version and its models are methodology, recorded in the full
report:

```bash
python3 -m venv /tmp/memenv && /tmp/memenv/bin/pip install mem0ai==2.2.1
node bench/drift/run.mjs --prepare /tmp/db      # writes t0 and t1 next to each other
MEM0_BASE_URL=https://ai-gateway.vercel.sh/v1 MEM0_API_KEY=... /tmp/memenv/bin/python bench/drift/mem0_arm.py \
  /tmp/db/t0/northwind /tmp/db/t1/northwind bench/drift/questions.json bench/drift/changes.json /tmp/memout
node bench/drift/run.mjs --semantic --memory /tmp/memout/mem0.json,/tmp/memout/mem0-oracle.json \
  --out bench/drift/results/latest.json --md bench/drift/results/latest.md --readme
```

With `OPENROUTER_API_KEY` alone it goes through OpenRouter. Taking the docs in is about 280 model calls and cost about
US$1 through an OpenAI-compatible gateway on 2026-10-10.

Each arm answers with its top 5 passages (the memory: its top 5 memories). A question is **fresh** when its current answer is
among them, **stale** when an answer that has stopped being true is among them (outside a passage marked as replaced)
and the current one is not, and **missed** otherwise; a deleted fact is stale whenever it comes back.

Latest full run: [2026-10-10](results/2026-10-10.md) (numbers in `results/2026-10-10.json`; `node bench/drift/run.mjs --from bench/drift/results/2026-10-10.json --md bench/drift/results/2026-10-10.md --readme`, from the repository root, writes its report and the README tables again).
