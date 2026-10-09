// DriftBench dataset check. Validates corpus/, changes.json and questions.json, and exits 1 with one line per problem.
// Zero dependencies: Node built-ins only. `applyChanges` is exported for the benchmark runner.
//
//   node bench/drift/check.mjs [dataset dir]      (defaults to the folder of this file)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KINDS = ["stable", "update", "moved", "deprecated", "deleted", "new", "paraphrase", "crosslingual"];
const QUESTION_KEYS = new Set(["id", "kind", "question", "t0", "t1", "file_t0", "file_t1"]);
const NOTICE = /^> \*\*Deprecated:\*\* replaced by \[([^\]]+)\]\(([^)\s]+)\)$/;
const CYRILLIC = /[Ѐ-ӿ]/;
const LIMITS = { files: [28, 34], lines: [30, 150], questions: [60, 70], token: 3 };

/** Matching used everywhere in DriftBench: case-insensitive substring after collapsing whitespace. */
export const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, " ");
export const contains = (text, answer) => answer != null && normalize(text).includes(normalize(answer).trim());

// ---- applying changes --------------------------------------------------------------------------------------------

/**
 * Applies changes.json to `dir` in order (sync, mutates `dir`). Throws on the first bad change, unless `onError` is
 * given, in which case it is called with each error and the remaining changes are still applied.
 */
export function applyChanges(dir, changes, { onError } = {}) {
  if (!Array.isArray(changes)) throw new Error("changes must be an array");
  const root = path.resolve(dir);
  changes.forEach((change, i) => {
    try {
      applyOne(root, change);
    } catch (err) {
      const what = change && typeof change === "object" ? `${change.op} ${change.file ?? `${change.from} -> ${change.to}`}` : "?";
      const wrapped = new Error(`changes[${i}] (${what}): ${err.message}`);
      if (onError) onError(wrapped, i);
      else throw wrapped;
    }
  });
  return dir;
}

function applyOne(root, c) {
  if (!c || typeof c !== "object") throw new Error("a change must be an object");
  switch (c.op) {
    case "edit": {
      const file = inside(root, field(c, "file"));
      const find = field(c, "find");
      const replace = field(c, "replace", { empty: true });
      if (!isFile(file)) throw new Error("file does not exist");
      const text = fs.readFileSync(file, "utf8");
      const n = occurrences(text, find);
      if (n !== 1) throw new Error(`find occurs ${n} times, expected exactly once: ${preview(find)}`);
      const at = text.indexOf(find);
      fs.writeFileSync(file, text.slice(0, at) + replace + text.slice(at + find.length));
      return;
    }
    case "add": {
      const file = inside(root, field(c, "file"));
      const text = field(c, "text");
      if (fs.existsSync(file)) throw new Error("file already exists");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return;
    }
    case "delete": {
      const file = inside(root, field(c, "file"));
      if (!isFile(file)) throw new Error("file does not exist");
      fs.unlinkSync(file);
      pruneEmptyDirs(root, path.dirname(file));
      return;
    }
    case "move": {
      const from = inside(root, field(c, "from"));
      const to = inside(root, field(c, "to"));
      if (!isFile(from)) throw new Error("source file does not exist");
      if (fs.existsSync(to)) throw new Error("target already exists");
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      pruneEmptyDirs(root, path.dirname(from));
      return;
    }
    case "prepend": {
      const file = inside(root, field(c, "file"));
      const text = field(c, "text");
      if (!isFile(file)) throw new Error("file does not exist");
      fs.writeFileSync(file, text + fs.readFileSync(file, "utf8"));
      return;
    }
    default:
      throw new Error(`unknown op ${JSON.stringify(c.op)}`);
  }
}

function field(c, name, { empty = false } = {}) {
  const v = c[name];
  if (typeof v !== "string" || (!empty && v === "")) throw new Error(`"${name}" must be a ${empty ? "" : "non-empty "}string`);
  return v;
}

function inside(root, rel) {
  if (path.isAbsolute(rel) || rel.includes("\\")) throw new Error(`path must be relative with forward slashes: ${rel}`);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error(`path escapes the corpus: ${rel}`);
  return full;
}

function occurrences(text, needle) {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) n++;
  return n;
}

function pruneEmptyDirs(root, dir) {
  while (dir.startsWith(root + path.sep) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const preview = (s) => JSON.stringify(s.length > 70 ? `${s.slice(0, 70)}...` : s);

// ---- reading a corpus state --------------------------------------------------------------------------------------

/** All files under `dir`: Map(relative posix path -> { raw, norm }). */
export function readCorpus(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const raw = fs.readFileSync(full, "utf8");
        out.set(path.relative(dir, full).split(path.sep).join("/"), { raw, norm: normalize(raw) });
      }
    }
  };
  walk(dir);
  return out;
}

const filesWith = (corpus, answer) => [...corpus].filter(([, f]) => f.norm.includes(normalize(answer).trim())).map(([p]) => p);

// ---- the check ---------------------------------------------------------------------------------------------------

export function check(datasetDir) {
  const problems = [];
  const problem = (msg) => problems.push(msg);
  const load = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(datasetDir, name), "utf8"));
    } catch (err) {
      problem(`${name}: cannot read: ${err.message}`);
      return null;
    }
  };
  const corpusDir = path.join(datasetDir, "corpus");
  if (!fs.existsSync(corpusDir)) return { problems: [`corpus/ not found in ${datasetDir}`] };
  const changes = load("changes.json");
  const questions = load("questions.json");
  if (!changes || !questions) return { problems };

  // t0, then t1 in a temp copy
  const t0 = readCorpus(corpusDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "driftbench-check-"));
  let t1;
  try {
    const t1Dir = path.join(tmp, "corpus");
    fs.cpSync(corpusDir, t1Dir, { recursive: true });
    applyChanges(t1Dir, changes, { onError: (err) => problem(err.message) });
    t1 = readCorpus(t1Dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const added = new Set(changes.filter((c) => c?.op === "add").map((c) => c.file));

  // corpus shape
  const [minFiles, maxFiles] = LIMITS.files;
  if (t0.size < minFiles || t0.size > maxFiles) problem(`corpus t0 has ${t0.size} files, expected ${minFiles}-${maxFiles}`);
  for (const [state, corpus] of [["t0", t0], ["t1", t1]]) {
    for (const [file, { raw }] of corpus) {
      if (!file.endsWith(".md")) problem(`${state} ${file}: not a Markdown file`);
      const lines = raw.replace(/\n$/, "").split("\n").length;
      const [lo, hi] = LIMITS.lines;
      if (lines < lo || lines > hi) problem(`${state} ${file}: ${lines} lines, expected ${lo}-${hi}`);
      const first = raw.split("\n", 1)[0];
      if (first.startsWith("> **Deprecated:**")) {
        const m = NOTICE.exec(first);
        const target = m && path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
        if (!m) problem(`${state} ${file}: malformed deprecation notice: ${first}`);
        else if (!corpus.has(target)) problem(`${state} ${file}: deprecation notice links to ${target}, which does not exist`);
      }
    }
  }

  // questions
  if (!Array.isArray(questions)) return { problems: [...problems, "questions.json must be an array"], t0, t1, changes, questions: [] };
  const [minQ, maxQ] = LIMITS.questions;
  if (questions.length < minQ || questions.length > maxQ) problem(`questions.json has ${questions.length} questions, expected ${minQ}-${maxQ}`);
  const ids = new Set();
  for (const q of questions) {
    const id = q?.id ?? "?";
    const bad = (msg) => problem(`${id} [${q?.kind}]: ${msg}`);
    if (!q || typeof q !== "object") {
      problem("a question must be an object");
      continue;
    }
    for (const k of Object.keys(q)) if (!QUESTION_KEYS.has(k)) bad(`unknown field "${k}"`);
    if (typeof q.id !== "string" || !/^q\d{2,3}$/.test(q.id)) bad(`id must look like q01`);
    else if (ids.has(q.id)) bad("duplicate id");
    ids.add(q.id);
    if (!KINDS.includes(q.kind)) {
      bad(`kind must be one of ${KINDS.join(", ")}`);
      continue;
    }
    if (typeof q.question !== "string" || q.question.trim().length < 10) bad("question must be a sentence");
    else if (q.kind === "crosslingual" ? !CYRILLIC.test(q.question) : CYRILLIC.test(q.question))
      bad(q.kind === "crosslingual" ? "a crosslingual question must be in Russian" : "only crosslingual questions are in Russian");

    let shapeOk = true;
    for (const t of ["t0", "t1"]) {
      const value = q[t];
      const file = q[`file_${t}`];
      if (value !== null && (typeof value !== "string" || normalize(value).trim().length < LIMITS.token)) {
        bad(`${t} must be null or a distinctive string of at least ${LIMITS.token} characters`);
        shapeOk = false;
      }
      if ((value === null) !== (file === null) || (file !== null && typeof file !== "string")) {
        bad(`${t} and file_${t} must both be null or both be set`);
        shapeOk = false;
      }
    }
    if (!shapeOk) continue;

    const same = q.t0 !== null && q.t1 !== null && normalize(q.t0).trim() === normalize(q.t1).trim();
    const need = (cond, msg) => cond || bad(msg);
    switch (q.kind) {
      case "stable":
      case "paraphrase":
      case "crosslingual":
        need(q.t0 !== null && same, "t0 and t1 must be the same answer");
        need(q.file_t0 === q.file_t1, "file_t0 and file_t1 must be the same file");
        break;
      case "update":
        need(q.t0 !== null && q.t1 !== null && !same, "t0 and t1 must be two different answers");
        need(q.file_t0 === q.file_t1, "file_t0 and file_t1 must be the same file");
        break;
      case "moved":
        need(q.t0 !== null && q.t1 !== null, "t0 and t1 must be set");
        need(q.file_t0 !== q.file_t1, "file_t1 must be a different file from file_t0");
        break;
      case "deprecated": {
        need(q.t0 !== null && q.t1 !== null && !same, "t0 and t1 must be two different answers");
        need(q.file_t0 !== q.file_t1, "file_t1 must be the new doc, not the deprecated one");
        need(added.has(q.file_t1) && !t0.has(q.file_t1), `the new doc ${q.file_t1} must be added by an add op`);
        const old = t1.get(q.file_t0);
        if (!old) {
          bad(`the deprecated doc ${q.file_t0} must still exist at t1`);
          break;
        }
        const m = NOTICE.exec(old.raw.split("\n", 1)[0]);
        if (!m) bad(`${q.file_t0} at t1 must start with "> **Deprecated:** replaced by [<title>](<relative path>)"`);
        else {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(q.file_t0), m[2]));
          need(target === q.file_t1, `the deprecation notice of ${q.file_t0} links to ${target}, not to ${q.file_t1}`);
        }
        need(contains(old.raw, q.t0), `the deprecated doc ${q.file_t0} must keep the old answer "${q.t0}" at t1`);
        break;
      }
      case "deleted":
        need(q.t0 !== null && q.t1 === null, "t0 must be set and t1 null");
        need(!t1.has(q.file_t0), `${q.file_t0} must be deleted at t1`);
        break;
      case "new":
        need(q.t0 === null && q.t1 !== null, "t0 must be null and t1 set");
        need(added.has(q.file_t1) && !t0.has(q.file_t1), `${q.file_t1} must be a doc added at t1`);
        break;
    }

    // where the answers occur
    if (q.t0 !== null) {
      const f = t0.get(q.file_t0);
      if (!f) bad(`file_t0 ${q.file_t0} does not exist at t0`);
      else need(contains(f.raw, q.t0), `t0 "${q.t0}" does not occur in ${q.file_t0} at t0`);
      const where = filesWith(t0, q.t0);
      need(where.length <= 1, `t0 "${q.t0}" occurs in ${where.length} files at t0: ${where.join(", ")}`);
    }
    if (q.t1 !== null) {
      const f = t1.get(q.file_t1);
      if (!f) bad(`file_t1 ${q.file_t1} does not exist at t1`);
      else need(contains(f.raw, q.t1), `t1 "${q.t1}" does not occur in ${q.file_t1} at t1`);
      const where = filesWith(t1, q.t1);
      need(where.length <= 1, `t1 "${q.t1}" occurs in ${where.length} files at t1: ${where.join(", ")}`);
    }
    if (["update", "moved", "deleted", "deprecated"].includes(q.kind) && q.t0 !== null && !same) {
      const allowed = q.kind === "deprecated" ? q.file_t0 : null;
      const where = filesWith(t1, q.t0).filter((p) => p !== allowed);
      need(where.length === 0, `old answer "${q.t0}" still occurs at t1 in: ${where.join(", ")}`);
    }
    if (["update", "moved", "new", "deprecated"].includes(q.kind) && q.t1 !== null && !same) {
      const where = filesWith(t0, q.t1);
      need(where.length === 0, `new answer "${q.t1}" already occurs at t0 in: ${where.join(", ")}`);
    }
  }
  return { problems, t0, t1, changes, questions };
}

function main() {
  const datasetDir = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)));
  const { problems, t0, t1, changes, questions } = check(datasetDir);
  if (t0 && t1) {
    const gone = [...t0.keys()].filter((p) => !t1.has(p));
    const fresh = [...t1.keys()].filter((p) => !t0.has(p));
    console.log(`corpus: ${t0.size} files at t0, ${t1.size} files at t1 (${fresh.length} new paths, ${gone.length} gone)`);
  }
  if (Array.isArray(changes)) {
    const ops = {};
    for (const c of changes) ops[c?.op] = (ops[c?.op] ?? 0) + 1;
    console.log(`changes: ${changes.length} (${Object.entries(ops).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  }
  if (Array.isArray(questions)) {
    const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const q of questions) if (q?.kind in kinds) kinds[q.kind]++;
    console.log(`questions: ${questions.length} (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("OK: dataset is consistent");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
