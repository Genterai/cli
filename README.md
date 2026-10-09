# Genter

**Memory for AI agents that does not go stale.**

[![npm](https://img.shields.io/npm/v/genter-cli)](https://www.npmjs.com/package/genter-cli)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

Memory layers keep a copy of what they were told. When your docs change, they go on answering from the copy.
Genter remembers **where** each answer is written, and reads it again every time you ask.

## See it in a second

```bash
npx genter-cli demo
```

No install, no key, no account: it runs on a temp folder.

```
$ genter ask "which port does the staging pooler use?"
  [1] docs/deploy.md:3-5 · Deploy › Staging
  Staging deploys every Tuesday from `main`. The pooler listens on port 6432.

Someone edits docs/deploy.md: Wednesday, port 5433. Nobody tells Genter.

$ genter ask "which port does the staging pooler use?"
  Since the last look: docs/deploy.md changed.

  [1] docs/deploy.md:3-5 · Deploy › Staging
      changed since the last look
  Staging deploys every Wednesday from `main`. The pooler listens on port 5433.

  A memory that kept a copy at the first question still answers:
  "Staging deploys every Tuesday from `main`. The pooler listens on port 6432."
```

## Use it

**On your folder.** It searches the folder you are in:

```bash
npx genter-cli ask "how do we deploy?"
```

**In your agent.** Claude Code:

```bash
claude mcp add genter -- npx -y genter-cli mcp
```

Cursor, Windsurf, Codex, VS Code or any MCP client:

```json
{ "mcpServers": { "genter": { "command": "npx", "args": ["-y", "genter-cli", "mcp"] } } }
```

Your agent gets `genter_find` (the passages that answer, read now, with `path:lines`), `genter_remember` (a note it
finds later, with its date), `genter_add` (a folder, a file or a website) and `genter_sources`.

**In code.** No dependencies:

```js
import { createLocal } from "genter-cli/local";

const genter = createLocal();
await genter.add("./docs");
const { results, changes } = await genter.find("how do we deploy?"); // [{ place: "docs/deploy.md:3-5", text, facts }]
```

## Why it does not go stale

- Each file or page is an **Anchor**: one read with a fixed argument (`FILE_READ docs/deploy.md`). Genter keeps where
  it is, its headings, its dates and a digest of it, never a copy of its text.
- Every question reads the sources again. A changed file is answered from its new text, *changed since the last look*;
  a deleted one is *gone* and answers nothing; one marked `Deprecated: replaced by [v2](v2.md)` brings v2 right after it.
- Taking a folder in calls no model: 200 files in 0.2 s. With no key, nothing leaves your computer.

## Benchmarks

**[DriftBench](bench/drift)**: the docs of a 40-person company, 61 edits over two months, the same 65 questions before and
after them, top 5 passages.

<!-- driftbench:start -->
| | needs | before the edits | after the edits: current answer | after the edits: stale answer |
| -- | -- | -- | -- | -- |
| **genter** | nothing | 80% | **77%** (89% of the changed facts) | **0%** |
| an index built once, same ranking | nothing | 80% | 34% (11%) | 42% |
| **genter --semantic** | an embeddings key | 92% | **88%** (92%) | **0%** |
| an index built once + vectors | an embeddings key | 92% | 42% (8%) | 43% |
| mem0 2.2.1, docs not added again | an LLM key, 35 packages, 277 LLM calls to take the docs in | at most 73%¹ | at most 3 of 32 changed facts¹ | 18 of 28 old values kept¹ |

¹ What mem0's memory holds at all, an upper bound for any search over it: its searches did not run (the key ran out
of credits). [Results](bench/drift/results/2026-10-09.md).
<!-- driftbench:end -->

**[LoCoMo and LongMemEval](bench/convo)**, the conversational-memory benchmarks: is the evidence among the passages
Genter finds? Words only, no key, no model.

| | questions | evidence in the top 5 | all of it in the top 5 | a search |
| -- | -- | -- | -- | -- |
| LoCoMo | 1,536 | 84.5% | 72.0% | 3 ms |
| LongMemEval-S | 470 | 96.6% | 82.3% (knowledge updates: 98.6%) | 110 ms |

This is retrieval, Genter's own job. Answers judged with each benchmark's own prompt (the numbers memory layers
publish): `node bench/convo/run.mjs --answer` with a key. [Results](bench/convo/results/2026-10-09.md).

## Commands

| | |
| -- | -- |
| `genter demo` | see it on a temp folder |
| `genter ask <question>` | the passages that answer, read now (the current folder, the first time) |
| `genter add <folder\|file\|url> ...` | search these from now on |
| `genter remember <text>` | keep a note in `~/.genter/notes.md`; edit it as you like |
| `genter sources` · `genter forget <...>` | what is searched; stop searching one |
| `genter mcp [folder\|url ...]` | all of it for your agent, over stdio |
| `genter login <token>` · `genter logout` | also find in your apps (below) |

`--json`, `--limit N`. Hidden files, `.gitignore`d files, lockfiles, keys and anything holding a private key are never
read. The store (`~/.genter`, or `GENTER_HOME`) is sealed with a secret made on the first run.

## Better ranking: `--semantic`

Words find a question asked in the docs' words. `--semantic` also ranks by meaning, so other words and other
languages find it too (DriftBench: Russian questions about English docs, 1 of 6 → 5 of 6). The passages go to the
provider you pick:

| Provider | Set |
| -- | -- |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` or `AI_GATEWAY_TOKEN` (free tier: `GENTER_EMBED_MODEL=google/gemini-embedding-001`) |
| Ollama, on your computer (nothing leaves it) | nothing: `ollama pull nomic-embed-text` |
| Any OpenAI-compatible endpoint | `GENTER_EMBED_URL`, `GENTER_EMBED_KEY`, `GENTER_EMBED_MODEL` |

The first key found is used; `--provider openai|openrouter|vercel|ollama` picks one.

## Your apps: Genter Cloud

Your mail, calendar, GitHub, Slack, Notion and 500 more are not folders. [Genter Cloud](https://genter.ai) connects
them and keeps their Anchors current by their own events. Make a token in Settings → API tokens, then:

```bash
genter login gnt_...
genter ask "what did Anna say about the contract?"   # your folders first, then your apps
```

`genter mcp` then finds in both too. `--local` skips the cloud.

| | `genter-cli` | Genter Cloud |
| -- | -- | -- |
| Sources | folders, files, websites, notes | + 500 apps |
| Kept current | read again on every question | + every event in an app rechecks the Anchors it touches |
| Ranking | words; meaning with your key | meaning, summaries and keywords written by a model, any language |
| People | you | a team: roles, an MCP address per agent, a call log |
| Price | free, Apache-2.0 | [plans](https://genter.ai) |

## More

- [Your apps on your own Composio keys](docs/apps.md): the agent (`run`, `find`, `write`), the library, the models.
- [The specs](https://github.com/Genterai/specs) Genter is built from.
- Releases: raise `version` in `package.json` in a pull request; merging it into `main` publishes it to npm and makes
  the GitHub release.

## License

[Apache-2.0](LICENSE).
