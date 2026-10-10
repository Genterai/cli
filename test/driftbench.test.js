import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fullReport, guard, label, readmeBlock, readmeGenter, replaceReadmeBlock } from "../bench/drift/report.mjs";

const bench = fileURLToPath(new URL("../bench/drift/", import.meta.url));

describe("DriftBench", () => {
  it("[spec:driftbench/checked] the dataset is consistent", () => {
    const out = spawnSync(process.execPath, [join(bench, "check.mjs")], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stdout + out.stderr);
  });

  // One offline run (one seeded timeline, one cold start) shared by the tests below.
  let results;
  const run = () => {
    if (results) return results;
    const dir = mkdtempSync(join(tmpdir(), "driftbench-"));
    try {
      const file = join(dir, "out.json");
      const env = { PATH: process.env.PATH, HOME: dir };
      const out = spawnSync(process.execPath, [join(bench, "run.mjs"), "--out", file, "--seeds", "1", "--runs", "1"], { encoding: "utf8", env });
      assert.equal(out.status, 0, out.stderr);
      results = JSON.parse(readFileSync(file, "utf8"));
      return results;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("[spec:driftbench/offline] [spec:local-search/reads-again] with no key, genter answers no stale fact and beats an index built once", () => {
    const rows = Object.fromEntries(run().rows.map((r) => [r.name, r.score]));
    const genter = rows.genter;
    const once = rows["index built once"];
    assert.equal(genter.t1.stale, 0);
    assert.equal(genter.t0.fresh, once.t0.fresh, "the same ranking before the edits");
    assert.ok(genter.t1_changed.fresh >= genter.t1_changed.n * 0.8, `changed facts: ${genter.t1_changed.fresh}/${genter.t1_changed.n}`);
    assert.ok(once.t1.stale > 0);
  });

  it("[spec:driftbench/arm-index-resynced] [spec:driftbench/over-time] genter is current at every time after an edit; an index re-synced every N minutes is stale until it re-syncs", () => {
    const t = run().over_time;
    const arm = (name) => t.arms.find((a) => a.name === name).by_delay;
    const at = (cells, minutes) => cells.find((c) => c.minutes === minutes);
    const genter = arm("genter");
    assert.deepEqual(t.delays, [1, 5, 15, 30, 60, 120]);
    for (const c of genter) assert.equal(c.stale, 0, `${c.minutes} min`);
    assert.equal(new Set(genter.map((c) => c.fresh)).size, 1, "genter's numbers do not depend on the time since the edit");
    const every15 = arm("index re-synced every 15 min");
    const every60 = arm("index re-synced every 60 min");
    assert.ok(at(every15, 1).stale > 0 && at(every60, 1).stale > 0);
    assert.equal(at(every15, 15).stale, 0, "re-synced within 15 minutes");
    assert.ok(at(every60, 30).stale > 0, "not yet re-synced");
    assert.equal(at(every60, 60).stale, 0);
    assert.equal(at(every15, 120).fresh, at(genter, 120).fresh, "the same ranking once re-synced");
  });

  it("[spec:driftbench/takes] [spec:driftbench/takes-store-checked] [spec:local-search/no-text-stored] what it takes is measured: no package, no network, no model call, no line of the docs' text kept", () => {
    const k = run().takes;
    assert.equal(k.packages.dependencies, 0);
    assert.equal(k.packages.installed, 0);
    assert.deepEqual(k.network, { connections: 0, lookups: 0, servers: 0, udp: 0 });
    assert.equal(k.model_calls_to_take_in, 0);
    assert.equal(k.docs.files, 34);
    assert.ok(k.store.body_lines.total > 1000);
    assert.equal(k.store.body_lines.kept, 0);
    assert.equal(k.store.heading_lines.kept, k.store.heading_lines.total, "headings are kept");
    assert.ok(k.cold_add_to_first_answer_ms.median > 0 && k.search_ms.median > 0);
  });

  it("[spec:driftbench/approach-labels] public tables name a baseline by its approach; the full report keeps its package as methodology", () => {
    const r = run();
    const memory = { ...r.rows[1], name: "mem0", model_calls_ingest: 277, ingest_ms: 480000, ask_ms: [300], info: { package: "mem0ai 2.2.1", packages: 34, memories: 561 } };
    const withMemory = { ...r, rows: [...r.rows, memory], method: ["The memory that extracts facts: mem0ai 2.2.1"] };
    const block = readmeBlock(withMemory, "bench/drift/results/x.md");
    assert.doesNotMatch(block, /mem0/i);
    assert.match(block, /a memory that extracts facts with a model/);
    assert.match(block, /an index re-synced every 15 minutes/);
    assert.equal(label("mem0 + oracle re-add"), label("memory + oracle re-add"));
    assert.match(fullReport(withMemory, { method: withMemory.method }), /## Methodology\n\n- The memory that extracts facts: mem0ai 2\.2\.1/);
  });

  it("[spec:driftbench/readme-generated] [spec:driftbench/scheduled-run] the README's tables come from a run, and a run worse than the README fails the guard", () => {
    const r = run();
    const readme = replaceReadmeBlock("# x\n<!-- driftbench:start -->\nold\n<!-- driftbench:end -->\nrest\n", readmeBlock(r, "r.md"));
    assert.doesNotMatch(readme, /\nold\n/);
    assert.match(readme, /\nrest\n$/);
    const g = r.rows.find((x) => x.name === "genter").score;
    assert.equal(readmeGenter(readme).t1_fresh, Math.round((100 * g.t1.fresh) / g.t1.n));
    assert.deepEqual(guard(r, readme), []);
    const higher = readme.replace(/\| \*\*genter\*\* \| nothing \| (\d+)% \| \*\*\d+%\*\*/, "| **genter** | nothing | $1% | **99%**");
    assert.equal(guard(r, higher).length, 1);
    const stale = { ...r, rows: r.rows.map((x) => (x.name === "genter" ? { ...x, score: { ...x.score, t1: { ...x.score.t1, stale: 1 } } } : x)) };
    assert.match(guard(stale, readme).join(), /stale/);
  });
});
