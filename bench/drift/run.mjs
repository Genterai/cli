// DriftBench runner: the same questions before and after two months of edits to a company's docs, asked of
//   genter            local search with words only: no key, no model, no package (src/local.js)
//   genter+semantic   the same with embeddings (--semantic, OPENROUTER_API_KEY)
//   index-once        the same ranking over the text kept when the docs were added: what any index built once returns
//   index-once+vec    the same with embeddings (with --semantic)
//   mem0              the real mem0 (bench/drift/mem0_arm.py), read from its results file when given (--mem0 <file>)
// A question is fresh when its current answer is in the top 5 passages; stale when an answer that is no longer true is
// there (outside a passage marked as replaced) and the current one is not; else missed.
// --answer also has a model answer each question from each arm's passages, judged by the same strings.
// Usage: node bench/drift/run.mjs [--semantic] [--answer] [--mem0 results.json] [--out file.json] [--prepare dir]
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bm25, prepare } from "../../src/lexical.js";
import { createLocal, embedderFor, embeddingProvider, fuse, listFolder } from "../../src/local.js";
import { chatModel, pool } from "../lib.mjs";
import { splitMarkdown } from "../../src/skills.js";
import { applyChanges } from "./check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const K = 5;
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

const pct = (x, n) => (n ? `${Math.round((100 * x) / n)}%` : "–");
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

function table(rows) {
  const lines = [
    "| arm | needs | before the edits | after: current answer | after: stale answer | after, changed facts | after, unchanged facts | LLM calls to take the docs in | texts embedded | median search |",
    "| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |",
  ];
  for (const r of rows) {
    const s = r.score;
    lines.push(`| ${r.name} | ${r.needs} | ${pct(s.t0.fresh, s.t0.n)} | ${pct(s.t1.fresh, s.t1.n)} | ${pct(s.t1.stale, s.t1.n)} | ${pct(s.t1_changed.fresh, s.t1_changed.n)} | ${pct(s.t1_unchanged.fresh, s.t1_unchanged.n)} | ${r.model_calls_ingest ?? 0} | ${r.embedded ?? 0} | ${r.ask_ms ? `${median(r.ask_ms)} ms` : "–"} |`);
  }
  return lines.join("\n");
}
function kindsTable(rows) {
  const kinds = Object.keys(rows[0].score.kinds);
  const lines = [`| kind (n) | ${rows.map((r) => r.name).join(" | ")} |`, `| -- | ${rows.map(() => "--").join(" | ")} |`];
  for (const k of kinds) lines.push(`| ${k} (${rows[0].score.kinds[k].n}) | ${rows.map((r) => `${r.score.kinds[k].fresh} fresh · ${r.score.kinds[k].stale} stale`).join(" | ")} |`);
  return lines.join("\n");
}

async function main() {
  const prepared = option("--prepare");
  if (prepared) {
    const { t0, t1 } = states(prepared);
    console.log(JSON.stringify({ t0, t1, questions: join(here, "questions.json") }));
    return;
  }
  // Embedding requests are counted: they are model calls too (an LLM writes nothing in these arms).
  const counted = (fn) => {
    const wrapped = async (texts) => {
      wrapped.texts += texts.length;
      return fn(texts);
    };
    wrapped.texts = 0;
    return wrapped;
  };
  const rows = [];
  const run = async (name, needs, fn) => {
    process.stderr.write(`${name}…\n`);
    const arm = await fn();
    rows.push({ name, needs, ...arm, score: score(arm), arm });
  };
  await run("genter", "nothing", () => genterArm());
  await run("index built once", "nothing", () => indexOnceArm());
  if (semantic) {
    const a = counted(embedderFor(embeddingProvider()));
    await run("genter --semantic", "OpenRouter key", () => genterArm({ embed: a }));
    rows.at(-1).embedded = a.texts;
    const b = counted(embedderFor(embeddingProvider()));
    await run("index built once + vectors", "OpenRouter key", () => indexOnceArm({ embed: b }));
    rows.at(-1).embedded = b.texts;
  }
  const mem0 = option("--mem0");
  for (const file of mem0 ? mem0.split(",") : []) {
    const m = JSON.parse(readFileSync(file, "utf8"));
    rows.push({ name: m.name, needs: m.needs, t0: m.t0, t1: m.t1, ingest_ms: m.ingest_ms, ask_ms: m.ask_ms, model_calls_ingest: m.model_calls_ingest, embedded: m.embedded, score: score(m), arm: m, info: m.info });
  }
  const report = [`DriftBench: ${questions.length} questions, ${changes.length} edits, top ${K} passages (${new Date().toISOString().slice(0, 10)})`, "", table(rows), "", kindsTable(rows)];
  if (flag("--answer")) {
    const answered = [];
    const m = chatModel();
    for (const r of rows) {
      process.stderr.write(`answers from ${r.name} (${m.provider} ${m.reader})…\n`);
      const a = await answers(r.arm, m);
      answered.push({ name: r.name, needs: r.needs, score: score(a), answers: a });
    }
    report.push("", "Answers by a model from each arm's passages (the same strings judge them):", "", table(answered));
    rows.push(...answered.map((a) => ({ ...a, name: `${a.name} → answer` })));
  }
  console.log(report.join("\n"));
  const file = option("--out");
  if (file) writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), k: K, questions: questions.length, edits: changes.length, rows: rows.map(({ arm, ...r }) => r) }, null, 2));
}

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
