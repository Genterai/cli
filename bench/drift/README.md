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
