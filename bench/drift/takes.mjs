// What it takes to answer from DriftBench's docs with genter, measured on this machine, never typed by hand:
//   packages      what `npm install genter-cli` installs besides it (package.json and package-lock.json)
//   cold start    a fresh `genter add` of the docs, then `genter ask`, two new processes, no key in the environment
//   network       connections, name lookups and servers those processes start (bench/drift/net-count.mjs): a model
//                 call or any service would be one
//   search        the median time of a search over the docs, in one process
//   kept          what the store holds once the docs are in: opened with its secret and searched for every line of
//                 the docs' text
// Usage: node bench/drift/takes.mjs [--runs 5]      (prints JSON; run.mjs includes it in its report)
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocal, listFolder } from "../../src/local.js";
import { cipher } from "../../src/seal.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Packages installed with genter-cli: its dependencies, and in the lockfile every package that is not for development.
export function packages() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const installed = Object.entries(lock.packages ?? {}).filter(([path, p]) => path && !p.dev && !p.devOptional && !p.peer);
  return { dependencies: Object.keys(pkg.dependencies ?? {}).length, installed: installed.length };
}

// Every file under a folder: [{ path, bytes }].
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ path: p, bytes: statSync(p).size });
    }
  };
  walk(dir);
  return out;
}

// All the strings a JSON value holds, keys included.
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, out.push(k) && out);
  return out;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

// The docs' text, line by line: headings apart from the body (lines of 20 characters or more; shorter ones, like
// "| --- |", are too common to tell anything).
function lines(dir) {
  const heading = [];
  const body = [];
  for (const path of listFolder(dir).files) {
    let fence = false;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (/^ {0,3}(```|~~~)/.test(raw)) fence = !fence;
      const line = norm(raw);
      if (!fence && /^#{1,6}\s/.test(line)) heading.push(norm(line.replace(/^#+\s*/, "")));
      else if (line.length >= 20) body.push(line);
    }
  }
  return { heading, body };
}

export async function whatItTakes({ runs = 5, question = "Which port does the staging Postgres pooler listen on?" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "driftbench-takes-"));
  try {
    const docs = join(base, "northwind");
    cpSync(join(here, "corpus"), docs, { recursive: true });
    const corpus = filesUnder(docs);
    const genter = join(root, "bin", "genter.js");
    const preload = pathToFileURL(join(here, "net-count.mjs")).href;
    const cold = [];
    const net = { connections: 0, lookups: 0, servers: 0, udp: 0 };
    let home;
    let answer;
    for (let i = 0; i < runs; i++) {
      home = join(base, `home-${i}`);
      // No key of any provider, no cloud token: only what a person who just installed it has.
      const env = { PATH: process.env.PATH, HOME: base, GENTER_HOME: home, NODE_OPTIONS: `--import=${preload}` };
      const step = (args, n) => {
        const out = spawnSync(process.execPath, [genter, ...args], { cwd: base, encoding: "utf8", env: { ...env, GENTER_NET_COUNT: join(base, `net-${i}-${n}.json`) } });
        if (out.status !== 0) throw new Error(`genter ${args[0]} failed: ${out.stderr}`);
        const c = JSON.parse(readFileSync(join(base, `net-${i}-${n}.json`), "utf8"));
        net.connections += c.connections.length;
        net.lookups += c.lookups;
        net.servers += c.servers;
        net.udp += c.udp;
        return out.stdout;
      };
      const started = process.hrtime.bigint();
      step(["add", docs], "add");
      answer = JSON.parse(step(["ask", question, "--json"], "ask"));
      cold.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    // Searches in one process, over the store the last cold run made.
    const local = createLocal({ home, cwd: base });
    const questions = JSON.parse(readFileSync(join(here, "questions.json"), "utf8"));
    const ms = [];
    for (const q of questions) {
      const started = process.hrtime.bigint();
      await local.find(q.question, { limit: 5 });
      ms.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    // What the store holds: every file of Genter's folder, the sealed store opened with its secret.
    const stored = filesUnder(home);
    const secret = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).secret;
    const state = cipher(`${secret}:default:local`).open(JSON.parse(readFileSync(join(home, "local.json"), "utf8")).blob);
    const raw = stored.filter((f) => !f.path.endsWith("local.json")).map((f) => readFileSync(f.path, "utf8"));
    const held = norm([...strings(state), ...raw].join("\n"));
    const text = lines(docs);
    const kept = (xs) => xs.filter((l) => held.includes(l));
    const body = kept(text.body);
    const headings = kept(text.heading);
    const fields = [...new Set(Object.values(state.anchors).flatMap((a) => Object.keys(a)))].sort();
    return {
      packages: packages(),
      docs: { files: corpus.length, bytes: corpus.reduce((n, f) => n + f.bytes, 0) },
      cold_add_to_first_answer_ms: { median: Math.round(median(cold)), runs: cold.map(Math.round) },
      first_answer: answer.results?.[0]?.place ?? null,
      network: net, // summed over every cold run's processes
      model_calls_to_take_in: net.connections, // a model call needs a connection; none was opened
      search_ms: { median: Math.round(median(ms) * 10) / 10, questions: ms.length },
      store: {
        files: stored.map((f) => ({ file: relative(home, f.path), bytes: f.bytes })),
        bytes: stored.reduce((n, f) => n + f.bytes, 0),
        sealed: true,
        places: Object.keys(state.anchors).length,
        fields,
        body_lines: { total: text.body.length, kept: body.length, bytes_kept: body.reduce((n, l) => n + Buffer.byteLength(l), 0) },
        heading_lines: { total: text.heading.length, kept: headings.length, bytes_kept: headings.reduce((n, l) => n + Buffer.byteLength(l), 0) },
      },
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--runs");
  console.log(JSON.stringify(await whatItTakes({ runs: i > 0 ? Number(process.argv[i + 1]) : 5 }), null, 2));
}
