import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const bench = fileURLToPath(new URL("../bench/drift/", import.meta.url));

describe("DriftBench", () => {
  it("[spec:driftbench/checked] the dataset is consistent", () => {
    const out = spawnSync(process.execPath, [join(bench, "check.mjs")], { encoding: "utf8" });
    assert.equal(out.status, 0, out.stdout + out.stderr);
  });

  it("[spec:driftbench/offline] [spec:local-search/reads-again] with no key, genter answers no stale fact and beats an index built once", () => {
    const dir = mkdtempSync(join(tmpdir(), "driftbench-"));
    try {
      const file = join(dir, "out.json");
      const env = { PATH: process.env.PATH, HOME: dir };
      const out = spawnSync(process.execPath, [join(bench, "run.mjs"), "--out", file], { encoding: "utf8", env });
      assert.equal(out.status, 0, out.stderr);
      const rows = Object.fromEntries(JSON.parse(readFileSync(file, "utf8")).rows.map((r) => [r.name, r.score]));
      const genter = rows.genter;
      const once = rows["index built once"];
      assert.equal(genter.t1.stale, 0);
      assert.equal(genter.t0.fresh, once.t0.fresh, "the same ranking before the edits");
      assert.ok(genter.t1_changed.fresh >= genter.t1_changed.n * 0.8, `changed facts: ${genter.t1_changed.fresh}/${genter.t1_changed.n}`);
      assert.ok(once.t1.stale > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
