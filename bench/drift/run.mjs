// DriftBench runner: the same questions before and after two months of edits to a company's docs, asked of
//   genter            local search with words only: no key, no model, no package (src/local.js)
//   genter+semantic   the same with embeddings (--semantic, OPENROUTER_API_KEY)
//   index-once        the same ranking over the text kept when the docs were added: what any index built once returns
//   index-once+vec    the same with embeddings (with --semantic)
//   memory            a memory that extracts facts with a model (bench/drift/mem0_arm.py), read from its results
//                     files when given (--memory <file>[,<file>])
//   over time         genter and an index re-synced every 15 and every 60 minutes, the edits landing at known times
//                     (--no-time skips it, --seeds N)
// and what it takes to answer with genter (bench/drift/takes.mjs; --no-takes skips it).
// A question is fresh when its current answer is in the top 5 passages; stale when an answer that is no longer true is
// there (outside a passage marked as replaced) and the current one is not; else missed.
// --answer also has a model answer each question from each arm's passages, judged by the same strings.
// Usage: node bench/drift/run.mjs [--semantic] [--answer] [--memory a.json,b.json] [--out results.json] [--md report.md]
//          [--readme] [--guard README.md] [--prepare dir] [--from results.json]
// --readme writes the tables into the README; --guard fails the run when genter does worse than the README says.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bm25, prepare } from "../../src/lexical.js";
import { createLocal, embedderFor, embeddingProvider, fuse, listFolder } from "../../src/local.js";
import { chatModel, pool } from "../lib.mjs";
import { splitMarkdown } from "../../src/skills.js";
import { applyChanges } from "./check.mjs";
import { fullReport, guard, readmeBlock, replaceReadmeBlock } from "./report.mjs";
import { whatItTakes } from "./takes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const K = 5;
const version = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version;
const semantic = flag("--semantic");

const questions = JSON.parse(readFileSync(join(here, "questions.json"), "utf8"));
const changes = JSON.parse(readFileSync(join(here, "changes.json"), "utf8"));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ");
const has = (text, answer) => answer != null && norm(text).includes(norm(answer));

// The two states of the corpus, t0 and t1, side by side in a temp folder (or in --prepare <dir> for the mem0 runner).
function states(base) {
  const t0 = join(base, "t0", "northwind");
  const t1 = join(base, "t1", "northwind");
  mkdirSync(dirname(t0), { recursive: true });
  cpSync(join(here, "corpus"), t0, { recursive: true });
  cpSync(join(here, "corpus"), t1, { recursive: true });
  applyChanges(t1, changes);
  return { t0, t1 };
}

// ---- arms ----

// Genter: one folder, added at t0; at t1 the same folder holds the edited docs (the edits are made in place).
async function genterArm({ embed } = {}) {
  const base = mkdtempSync(join(tmpdir(), "driftbench-genter-"));
  const live = join(base, "northwind");
  cpSync(join(here, "corpus"), live, { recursive: true });
  const local = createLocal({ home: join(base, "home"), secret: "bench", cwd: base, embed });
  const out = { t0: [], t1: [], ingest_ms: 0, ask_ms: [], model_calls_ingest: 0 };
  let started = Date.now();
  await local.add(live);
  out.ingest_ms = Date.now() - started;
  for (const phase of ["t0", "t1"]) {
    if (phase === "t1") applyChanges(live, changes);
    for (const q of questions) {
      started = Date.now();
      const found = await local.find(q.question, { limit: K });
      out.ask_ms.push(Date.now() - started);
      out[phase].push(found.results.map((r) => ({ text: r.text, place: relative(live, r.path ?? "") , replaced: Boolean(r.anchor.superseded) })));
    }
  }
  rmSync(base, { recursive: true, force: true });
  return out;
}

// An index built once: the sections of every file as they were when it was made, ranked the same way.
async function indexOnceArm({ embed } = {}) {
  const base = mkdtempSync(join(tmpdir(), "driftbench-index-"));
  const { t0 } = states(base);
  let started = Date.now();
  const sections = [];
  for (const path of listFolder(t0).files) {
    const text = readFileSync(path, "utf8");
    const name = relative(t0, path);
    for (const p of splitMarkdown(name, text)) {
      const body = text.slice(p.start, p.end);
      if (!body.trim()) continue;
      const headings = p.headings[0] === "Introduction" && p.headings.length === 1 ? [] : p.headings;
      sections.push({ place: name, headings, text: body, doc: prepare({ head: `${name.split("/").pop()} ${headings.join(" ")}`, body }) });
    }
  }
  let vectors = null;
  if (embed) vectors = await embed(sections.map((s) => `${s.headings.join(" › ")}\n${s.text.slice(0, 2000)}`)).then((v) => v.map(unit));
  const out = { t0: [], t1: [], ingest_ms: Date.now() - started, ask_ms: [], model_calls_ingest: 0 };
  for (const phase of ["t0", "t1"]) {
    for (const q of questions) {
      started = Date.now();
      let scores = bm25(q.question, sections.map((s) => s.doc));
      if (vectors) {
        const [qv] = (await embed([q.question])).map(unit);
        scores = fuse(scores, vectors.map((v) => dot(qv, v)));
      }
      out.ask_ms.push(Date.now() - started);
      out[phase].push(top(sections, scores).map((s) => ({ text: s.text, place: s.place, replaced: false })));
    }
  }
  rmSync(base, { recursive: true, force: true });
  return out;
}

// ---- freshness over time ----

// The edits land one by one at known times; each changed fact is asked again some minutes after the edit that made its
// current answer, of
//   genter                      the live folder, read at each question
//   index re-synced every N     Genter's own search over a copy of the folder taken every N minutes since the docs went
//                               in: the same ranking, so only freshness differs
// Times are drawn from a seeded generator (no clock, no key, no network): the same seeds give the same numbers.
export const DELAYS = [1, 5, 15, 30, 60, 120]; // minutes after the edit
export const SYNC_EVERY = [15, 60]; // minutes between re-syncs of the index
const MINUTE = 60_000;

// mulberry32: a small seeded generator, so a timeline is the same on every machine.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The corpus after each number of edits: states[j] = Map(relative path -> text) after the first j edits.
function corpusStates() {
  const base = mkdtempSync(join(tmpdir(), "driftbench-states-"));
  const dir = join(base, "northwind");
  cpSync(join(here, "corpus"), dir, { recursive: true });
  const read = () => new Map(listFolder(dir).files.map((p) => [relative(dir, p), readFileSync(p, "utf8")]));
  const out = [read()];
  for (const c of changes) {
    applyChanges(dir, [c]);
    out.push(read());
  }
  rmSync(base, { recursive: true, force: true });
  return out;
}

// The edit after which a question's answer is where it is at the end: from state k on, the files holding its old and
// its new answer (and whether they mark themselves as replaced) stay as they are after the last edit. null: never moves.
export function landing(q, states) {
  const sig = (state) =>
    JSON.stringify(
      [...state]
        .filter(([, text]) => has(text, q.t0) || has(text, q.t1))
        .map(([file, text]) => [file, has(text, q.t0), has(text, q.t1), /deprecated/i.test(text.slice(0, 300))])
        .sort(),
    );
  const end = sig(states.at(-1));
  let k = states.length - 1;
  while (k > 0 && sig(states[k - 1]) === end) k--;
  return k === 0 ? null : k;
}

async function overTimeArm({ seeds = 5 } = {}) {
  const states = corpusStates();
  const asked = questions.map((q, i) => ({ q, i, k: landing(q, states) })).filter((x) => x.k != null);
  const arms = [{ name: "genter", every: null }, ...SYNC_EVERY.map((n) => ({ name: `index re-synced every ${n} min`, every: n }))];
  const tally = Object.fromEntries(arms.map((a) => [a.name, DELAYS.map((d) => ({ minutes: d, n: 0, fresh: 0, stale: 0, missed: 0 }))]));
  let span = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const random = seeded(seed);
    // Edit j lands 2 to 30 minutes after the one before it; the docs went in, and the indexes were built, at 0.
    const at = [];
    for (let j = 0, t = 0; j < changes.length; j++) at.push((t += (2 + 28 * random()) * MINUTE));
    span = Math.max(span, at.at(-1));
    const base = mkdtempSync(join(tmpdir(), "driftbench-time-"));
    const folder = (name) => {
      const dir = join(base, name, "northwind");
      cpSync(join(here, "corpus"), dir, { recursive: true });
      return dir;
    };
    const live = folder("live");
    const runs = [];
    for (const a of arms) {
      const dir = a.every ? folder(`every-${a.every}`) : live;
      const local = createLocal({ home: join(base, `home-${a.name}`), secret: "bench", cwd: base });
      await local.add(dir);
      runs.push({ ...a, dir, local, synced: 0 });
    }
    const events = asked.flatMap((x) => DELAYS.map((d, di) => ({ ...x, di, t: at[x.k - 1] + d * MINUTE }))).sort((a, b) => a.t - b.t);
    let applied = 0;
    for (const e of events) {
      while (applied < changes.length && at[applied] <= e.t) applyChanges(live, [changes[applied++]]);
      for (const r of runs) {
        if (r.every) {
          // The last re-sync before this question copied the folder as it was then.
          const last = Math.floor(e.t / (r.every * MINUTE)) * r.every * MINUTE;
          const j = at.filter((x) => x <= last).length;
          if (j !== r.synced) {
            rmSync(r.dir, { recursive: true, force: true });
            for (const [file, text] of states[j]) {
              mkdirSync(dirname(join(r.dir, file)), { recursive: true });
              writeFileSync(join(r.dir, file), text);
            }
            r.synced = j;
          }
        }
        const found = await r.local.find(e.q.question, { limit: K });
        const passages = found.results.map((p) => ({ text: p.text, replaced: Boolean(p.anchor.superseded) }));
        const cell = tally[r.name][e.di];
        cell.n++;
        cell[verdict(e.q, passages, "t1")]++;
      }
    }
    rmSync(base, { recursive: true, force: true });
  }
  return { seeds, facts: asked.length, edits_span_minutes: Math.round(span / MINUTE), delays: DELAYS, arms: arms.map((a) => ({ name: a.name, every_minutes: a.every, by_delay: tally[a.name] })) };
}

function top(sections, scores) {
  const per = new Map();
  const picked = [];
  for (const [s] of sections.map((s, i) => [s, scores[i]]).filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1])) {
    const n = per.get(s.place) ?? 0;
    if (n >= 2) continue;
    per.set(s.place, n + 1);
    picked.push(s);
    if (picked.length >= K) break;
  }
  return picked;
}
const unit = (v) => {
  const s = Array.from(v).slice(0, 256);
  const n = Math.hypot(...s) || 1;
  return s.map((x) => x / n);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// ---- scoring ----

function verdict(q, passages, phase) {
  const all = passages.map((p) => p.text).join("\n");
  const unflagged = passages.filter((p) => !p.replaced).map((p) => p.text).join("\n");
  if (phase === "t0") return q.t0 == null ? null : has(all, q.t0) ? "fresh" : "missed";
  if (q.t1 == null) return has(unflagged, q.t0) ? "stale" : "fresh"; // deleted: the old fact must not come back as current
  if (has(all, q.t1)) return "fresh";
  if (q.t0 != null && q.t0 !== q.t1 && has(unflagged, q.t0)) return "stale";
  return "missed";
}

function score(arm) {
  const by = (phase, filter = () => true) => {
    const v = questions.map((q, i) => [q, verdict(q, arm[phase][i] ?? [], phase)]).filter(([q, x]) => x && filter(q));
    const n = v.length;
    const count = (x) => v.filter(([, y]) => y === x).length;
    return { n, fresh: count("fresh"), stale: count("stale"), missed: count("missed") };
  };
  const changed = (q) => !["stable", "paraphrase", "crosslingual"].includes(q.kind);
  const kinds = [...new Set(questions.map((q) => q.kind))];
  return {
    t0: by("t0"),
    t1: by("t1"),
    t1_changed: by("t1", changed),
    t1_unchanged: by("t1", (q) => !changed(q)),
    kinds: Object.fromEntries(kinds.map((k) => [k, by("t1", (q) => q.kind === k)])),
  };
}

// ---- answers by a model (optional) ----

async function answers(arm, m) {
  const out = { t0: [], t1: [] };
  for (const phase of ["t0", "t1"]) {
    out[phase] = await pool(questions.map((q, i) => [q, arm[phase][i] ?? []]), 8, async ([q, passages]) => {
      const context = passages.map((p, i) => `[${i + 1}]${p.replaced ? " (this document marks itself as replaced)" : ""}\n${p.text.slice(0, 1500)}`).join("\n\n");
      const text = await m
        .chat(m.reader, [
          { role: "system", content: "Answer the question from the passages only, in one short sentence with the exact value. If the passages disagree, prefer the one that replaces the other. If they do not hold the answer, say: not found." },
          { role: "user", content: `Passages:\n${context || "(none)"}\n\nQuestion: ${q.question}` },
        ])
        .catch((e) => `error: ${e.message}`);
      return [{ text, replaced: false }];
    });
  }
  return out;
}

// ---- report ----

// Where this run's code is: the commit, when run from a clone.
function commit() {
  const out = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
}

async function main() {
  const prepared = option("--prepare");
  if (prepared) {
    const { t0, t1 } = states(prepared);
    console.log(JSON.stringify({ t0, t1, questions: join(here, "questions.json") }));
    return;
  }
  // --from <results.json>: the reports again from a kept run, nothing run (and nothing paid) twice.
  const from = option("--from");
  if (from) return write(JSON.parse(readFileSync(from, "utf8")));
  // Embedding requests are counted: they are model calls too (an LLM writes nothing in these arms).
  const counted = (fn) => {
    const wrapped = async (texts) => {
      wrapped.texts += texts.length;
      return fn(texts);
    };
    wrapped.texts = 0;
    return Object.assign(wrapped, { model: fn.model, provider: fn.provider });
  };
  const rows = [];
  const method = [`genter-cli ${version}${commit() ? ` at ${commit()}` : ""}; Node ${process.version}.`];
  const run = async (name, fn) => {
    process.stderr.write(`${name}…\n`);
    const arm = await fn();
    rows.push({ name, ...arm, score: score(arm), arm });
  };
  await run("genter", () => genterArm());
  await run("index built once", () => indexOnceArm());
  if (semantic) {
    const a = counted(embedderFor(embeddingProvider()));
    await run("genter --semantic", () => genterArm({ embed: a }));
    rows.at(-1).embedded = a.texts;
    const b = counted(embedderFor(embeddingProvider()));
    await run("index built once + vectors", () => indexOnceArm({ embed: b }));
    rows.at(-1).embedded = b.texts;
    method.push(`Embeddings: ${a.model} through ${a.provider}, the first 256 numbers of each vector.`);
  }
  // The memory that extracts facts with a model, from the results files of bench/drift/mem0_arm.py.
  const memory = option("--memory") ?? option("--mem0");
  for (const file of memory ? memory.split(",") : []) {
    const m = JSON.parse(readFileSync(file, "utf8"));
    rows.push({ name: m.name, t0: m.t0, t1: m.t1, ingest_ms: m.ingest_ms, ask_ms: m.ask_ms, model_calls_ingest: m.model_calls_ingest, embedded: m.embedded, score: score(m), arm: m, info: m.info });
    if (m.info?.package && !method.some((x) => x.includes(m.info.package))) method.push(`The memory that extracts facts: ${m.info.package} (${m.info.install ?? "its default install"}), its LLM ${m.info.llm} and embeddings ${m.info.embed ?? "text-embedding-3-small"} through ${m.info.provider ?? "an OpenAI-compatible gateway"}, local vector store; given each of the ${m.info.sections} sections with fact extraction on, ${m.info.errors?.length ?? 0} of them failed${m.info.extraction_replies_not_json ? ` (and ${m.info.extraction_replies_not_json} extraction replies were not valid JSON${m.info.inserts_failed ? `, ${m.info.inserts_failed} inserts failed` : ""}: logged by the library, which went on)` : ""}${m.info.reingest ? `; the oracle arm deleted the memories of the ${m.info.reingest.files} files the edits touched and added them again from after the edits (${m.info.reingest.llm_calls} more LLM calls)` : ""}.`);
  }
  if (!flag("--no-time")) {
    process.stderr.write("over time…\n");
    over = await overTimeArm({ seeds: Number(option("--seeds") ?? 5) });
  }
  if (!flag("--no-takes")) {
    process.stderr.write("what it takes…\n");
    takes = await whatItTakes({ runs: Number(option("--runs") ?? 5) });
  }
  if (flag("--answer")) {
    const m = chatModel();
    for (const r of [...rows]) {
      process.stderr.write(`answers from ${r.name} (${m.provider} ${m.reader})…\n`);
      const a = await answers(r.arm, m);
      rows.push({ name: `${r.name} → answer`, score: score(a), answers: a });
    }
    method.push(`Answers: ${m.reader} through ${m.provider}, temperature 0.`);
  }
  write({ at: new Date().toISOString(), k: K, questions: questions.length, edits: changes.length, rows: rows.map(({ arm, ...r }) => r), over_time: over, takes, method });
}

function write(results) {
  const method = results.method ?? [];
  console.log(fullReport(results, { method }));
  const file = option("--out");
  if (file) writeFileSync(file, JSON.stringify(results, null, 2));
  const md = option("--md");
  if (md) writeFileSync(md, fullReport(results, { method }));
  if (flag("--readme")) {
    const readme = join(here, "..", "..", "README.md");
    const link = relative(dirname(readme), md ?? file ?? "bench/drift/results");
    writeFileSync(readme, replaceReadmeBlock(readFileSync(readme, "utf8"), readmeBlock(results, link)));
  }
  const guarded = option("--guard");
  if (guarded) {
    const problems = guard(results, readFileSync(guarded, "utf8"));
    for (const p of problems) console.error(`DriftBench guard: ${p}`);
    if (problems.length) process.exitCode = 1;
  }
}
let over = null;
let takes = null;

// Files and their sizes of the corpus, for the report.
export function corpusSize(dir = join(here, "corpus")) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else {
        files++;
        bytes += statSync(join(d, e.name)).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

await main();
