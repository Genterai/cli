"""DriftBench arm for mem0 (pip install mem0ai), the real library with its defaults (gpt-5-mini, text-embedding-3-small,
local Qdrant), both through OpenRouter (OPENROUTER_API_KEY).

The docs go in section by section with infer=True (mem0 extracts facts with its LLM). Then the questions are asked at t0,
and at t1 twice:
  mem0            nothing told: what a memory returns when the docs change and nobody re-adds them
  mem0 + oracle   every file the edits touched has its memories deleted and is added again from t1: a perfect change
                  feed, which Genter does not need
Writes two result files for run.mjs --mem0.

  node bench/drift/run.mjs --prepare /tmp/db        # prints {t0, t1, questions}
  python bench/drift/mem0_arm.py /tmp/db/t0/northwind /tmp/db/t1/northwind bench/drift/questions.json bench/drift/changes.json /tmp/mem0
"""

import json
import os
import re
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

os.environ.setdefault("MEM0_TELEMETRY", "false")

from mem0 import Memory  # noqa: E402

K = 5
USER = "bench"


def sections(root, rel):
    """The sections of one Markdown file: [(text, rel)], each under its heading path."""
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        return []
    text = open(path, encoding="utf8").read()
    out, current, stack, fence = [], [], [], False
    for line in text.split("\n"):
        if re.match(r"^ {0,3}(```|~~~)", line):
            fence = not fence
        m = None if fence else re.match(r"^(#{1,3})\s+(.+?)\s*#*\s*$", line)
        if m:
            if "".join(current).strip():
                out.append(current)
            level = len(m.group(1))
            stack = [s for s in stack if s[0] < level] + [(level, m.group(2))]
            current = [" > ".join(s[1] for s in stack) + "\n"]
        else:
            current.append(line + "\n")
    if "".join(current).strip():
        out.append(current)
    return [(f"From {rel}: " + "".join(s).strip(), rel) for s in out if len("".join(s).strip()) > 20]


def files(root):
    out = []
    for d, _, names in os.walk(root):
        for n in names:
            if n.endswith(".md"):
                out.append(os.path.relpath(os.path.join(d, n), root))
    return sorted(out)


def main():
    t0, t1, questions_file, changes_file, out_dir = sys.argv[1:6]
    workers = int(os.environ.get("MEM0_WORKERS", "6"))
    # Any OpenAI-compatible gateway: MEM0_BASE_URL + MEM0_API_KEY (e.g. Vercel AI Gateway), else OpenRouter.
    base_url = os.environ.get("MEM0_BASE_URL", "https://openrouter.ai/api/v1")
    key = os.environ.get("MEM0_API_KEY") or os.environ["OPENROUTER_API_KEY"]
    if "MEM0_BASE_URL" in os.environ:
        os.environ.pop("OPENROUTER_API_KEY", None)  # mem0 sends every LLM call to OpenRouter when this is set
    embed_model = os.environ.get("MEM0_EMBED_MODEL", "openai/text-embedding-3-small")
    dims = int(os.environ.get("MEM0_EMBED_DIMS", "1536"))
    # MEM0_STORE: a store an earlier run filled, to ask again without adding the docs (and paying for it) twice.
    resume = os.environ.get("MEM0_STORE")
    store = resume or tempfile.mkdtemp(prefix="mem0-bench-")
    config = {
        "llm": {"provider": "openai", "config": {"model": os.environ.get("MEM0_LLM", "openai/gpt-5-mini"), "api_key": key, "openai_base_url": base_url}},
        "embedder": {"provider": "openai", "config": {"model": embed_model, "api_key": key, "openai_base_url": base_url, "embedding_dims": dims}},
        "vector_store": {"provider": "qdrant", "config": {"path": os.path.join(store, "qdrant"), "collection_name": "bench", "embedding_model_dims": dims, "on_disk": True}},
        "history_db_path": os.path.join(store, "history.db"),
    }
    m = Memory.from_config(config)

    calls = {"llm": 0, "embed": 0}
    llm_call, embed_call = m.llm.generate_response, m.embedding_model.embed

    def counted_llm(*a, **kw):
        calls["llm"] += 1
        return llm_call(*a, **kw)

    def counted_embed(*a, **kw):
        calls["embed"] += 1
        return embed_call(*a, **kw)

    m.llm.generate_response, m.embedding_model.embed = counted_llm, counted_embed

    def add_all(items):
        errors = []

        def one(item):
            text, rel = item
            for attempt in range(3):
                try:
                    return m.add([{"role": "user", "content": text}], user_id=USER, metadata={"source": rel}, infer=True)
                except Exception as e:  # a provider hiccup: try again, then count it
                    if attempt == 2:
                        errors.append(f"{rel}: {e}")
                    time.sleep(2)

        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(one, items))
        return errors

    questions = json.load(open(questions_file))
    changes = json.load(open(changes_file))

    def ask():
        out, ms = [], []
        for q in questions:
            started = time.time()
            found = m.search(q["question"], top_k=K, filters={"user_id": USER})
            ms.append(round((time.time() - started) * 1000))
            out.append([{"text": r["memory"], "place": (r.get("metadata") or {}).get("source"), "replaced": False} for r in found.get("results", [])])
        return out, ms

    os.makedirs(out_dir, exist_ok=True)
    items = [s for rel in files(t0) for s in sections(t0, rel)]
    if resume:
        ingest = json.load(open(os.path.join(out_dir, "ingest.json")))
        ingest_ms, ingest_calls, errors = ingest["ms"], ingest["calls"], ingest["errors"]
    else:
        started = time.time()
        errors = add_all(items)
        ingest_ms = round((time.time() - started) * 1000)
        ingest_calls = dict(calls)
        # Kept before any search: the docs went in once, at a price, whatever happens next.
        json.dump({"store": store, "ms": ingest_ms, "calls": ingest_calls, "errors": errors, "sections": len(items)}, open(os.path.join(out_dir, "ingest.json"), "w"), indent=1)
    stored = len(m.get_all(filters={"user_id": USER}, top_k=100000).get("results", []))
    print(f"mem0: {len(items)} sections in, {stored} memories, {ingest_calls} model calls, {ingest_ms} ms, {len(errors)} errors (store {store})", file=sys.stderr)

    at_t0, ms0 = ask()
    at_t1, ms1 = ask()

    touched = set()
    for c in changes:
        for k in ("file", "from", "to"):
            if c.get(k):
                touched.add(c[k])
    calls.update(llm=0, embed=0)
    started = time.time()
    for rel in sorted(touched):
        for r in m.get_all(filters={"user_id": USER, "source": rel}, top_k=100000).get("results", []):
            m.delete(r["id"])
    errors2 = add_all([s for rel in sorted(touched) for s in sections(t1, rel)])
    reingest_ms = round((time.time() - started) * 1000)
    reingest_calls = dict(calls)
    at_t1_oracle, ms2 = ask()

    info = {"sections": len(items), "memories": stored, "errors": errors + errors2, "llm": config["llm"]["config"]["model"], "embed_calls_ingest": ingest_calls["embed"], "reingest": {"files": len(touched), "llm_calls": reingest_calls["llm"], "ms": reingest_ms}}
    base = {"needs": "OpenAI-compatible key + 35 packages", "t0": at_t0, "ingest_ms": ingest_ms, "model_calls_ingest": ingest_calls["llm"], "info": info}
    json.dump({**base, "name": "mem0", "t1": at_t1, "ask_ms": ms0 + ms1}, open(os.path.join(out_dir, "mem0.json"), "w"), indent=1)
    json.dump({**base, "name": "mem0 + oracle re-add", "t1": at_t1_oracle, "ask_ms": ms0 + ms2, "model_calls_ingest": ingest_calls["llm"] + reingest_calls["llm"]}, open(os.path.join(out_dir, "mem0-oracle.json"), "w"), indent=1)
    print(json.dumps(info), file=sys.stderr)


if __name__ == "__main__":
    main()
