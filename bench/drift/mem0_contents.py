"""What mem0's memory holds after the docs went in, read from its local Qdrant store with no API call: how many of the
answers are in any memory at all (an upper bound for any search over it), before and after the edits when nothing is
added again.

  python bench/drift/mem0_contents.py <store> bench/drift/questions.json      # <store>: ingest.json's "store"
"""

import json
import re
import sys

from qdrant_client import QdrantClient

store, questions = sys.argv[1], json.load(open(sys.argv[2]))
client = QdrantClient(path=store + "/qdrant")
points, offset = [], None
while True:
    batch, offset = client.scroll("bench", limit=1000, offset=offset, with_payload=True, with_vectors=False)
    points += batch
    if offset is None:
        break
client.close()


def norm(s):
    return re.sub(r"\s+", " ", str(s).lower())


blob = norm("\n".join(p.payload.get("data", "") for p in points))
changed = [q for q in questions if q["kind"] not in ("stable", "paraphrase", "crosslingual")]
old = [q for q in changed if q["t0"] and q["t0"] != q.get("t1")]
current = [q for q in changed if q.get("t1")]
before = [q for q in questions if q["t0"]]
print(json.dumps({
    "memories": len(points),
    "before_edits_answers_in_memory": [sum(norm(q["t0"]) in blob for q in before), len(before)],
    "after_edits_old_values_in_memory": [sum(norm(q["t0"]) in blob for q in old), len(old)],
    "after_edits_current_values_in_memory": [sum(norm(q["t1"]) in blob for q in current), len(current)],
}, indent=1))
