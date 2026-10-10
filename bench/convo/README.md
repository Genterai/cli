# LoCoMo and LongMemEval on Genter

The two conversational-memory benchmarks memory layers report their scores on, run on Genter's local search with nothing added for them: every session of a conversation becomes a
Markdown file (a heading with its date, a section every few turns), the folder is added with `genter add`, and each
question is asked with `genter ask`. Taking a conversation in calls no model.

| | LoCoMo | LongMemEval-S (cleaned) |
| -- | -- | -- |
| What it is | 10 long conversations between two people, about 1,540 questions (categories 1-4; 5, adversarial, left out as published runs do) | 500 questions, each with its own history of about 48 user–assistant sessions; 30 abstention questions |
| Evidence | the turns (`D3:12`) that hold the answer | the sessions that hold it |
| Source | [snap-research/locomo](https://github.com/snap-research/locomo) | [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) |

## Two measures

- **Retrieval** (no key, no model): is the evidence among the passages Genter returns, at 5 and 10 passages: *any* of it,
  and *all* of it. This is Genter's own job: it finds, the agent answers.
- **Answers** (`--answer`, a key of any OpenAI-compatible provider): a model answers each question from the 10 passages,
  and a judge grades it with the benchmark's own prompt: LongMemEval's `evaluate_qa.py`, and for LoCoMo the
  `llm_judge.py` published with a memory layer's LoCoMo evaluation (gpt-4o-mini). These are the numbers memory layers publish.

## Running it

```bash
node bench/convo/run.mjs --download                  # into ~/.cache/genter-bench (280 MB)
node bench/convo/run.mjs                             # retrieval, words only: ~5 s for LoCoMo, ~70 s for LongMemEval-S
OPENAI_API_KEY=... node bench/convo/run.mjs --semantic --answer --out results/run.json
```

`--only locomo|longmemeval`, `--limit N` (questions per benchmark), `BENCH_MODEL` (reader) and `BENCH_JUDGE` (judge),
gpt-4o-mini by default, through the same providers as `--semantic` (OpenAI, OpenRouter, Vercel AI Gateway, Ollama).

## Results

[2026-10-09, words only](results/2026-10-09.md). Answers with a model are not run yet.
