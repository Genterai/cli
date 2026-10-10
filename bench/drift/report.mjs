// DriftBench's reports, made from a run's results (run.mjs --out): the full report kept beside the benchmark, the block
// of the README between <!-- driftbench:start --> and <!-- driftbench:end -->, and the numbers the weekly run is held to.
// Public tables name a baseline by its approach, never by a product; the full report adds the exact package and version
// of each baseline, so a run can be reproduced.

// The arms as the tables show them.
const LABELS = {
  genter: "**genter**",
  "index built once": "an index built once, same ranking",
  "genter --semantic": "**genter --semantic**",
  "index built once + vectors": "an index built once + vectors",
  mem0: "a memory that extracts facts with a model, docs not added again",
  "mem0 + oracle re-add": "the same memory, every edited file deleted from it and added again",
  memory: "a memory that extracts facts with a model, docs not added again",
  "memory + oracle re-add": "the same memory, every edited file deleted from it and added again",
};
export const label = (name) => LABELS[name] ?? name;
const ours = (name) => name.startsWith("genter");

const pct = (x, n) => (n ? `${Math.round((100 * x) / n)}%` : "–");
const median = (xs) => (xs?.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const bold = (name, s) => (ours(name) ? `**${s}**` : s);
const duration = (ms) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);

function needs(r) {
  if (r.name === "genter" || r.name === "index built once") return "nothing";
  if (r.name.includes("--semantic") || r.name.includes("vectors")) return "an embeddings key";
  const packages = r.info?.packages ? `, ${r.info.packages} packages` : "";
  const again = r.info?.reingest && r.name.includes("oracle") ? r.info.reingest.llm_calls : 0;
  return `an LLM key${packages}, ${r.model_calls_ingest - again} LLM calls to take the docs in${again ? `, ${again} more to add the edited files again` : ""}`;
}

// The arms that ran on the docs before and after the edits (not the answers of a model).
const armsOf = (results) => results.rows.filter((r) => !r.name.endsWith("→ answer"));

export function mainTable(results) {
  const lines = ["| | needs | before the edits | after the edits: current answer | after the edits: stale answer |", "| -- | -- | -- | -- | -- |"];
  for (const r of armsOf(results)) {
    const s = r.score;
    lines.push(`| ${label(r.name)} | ${needs(r)} | ${pct(s.t0.fresh, s.t0.n)} | ${bold(r.name, pct(s.t1.fresh, s.t1.n))} (${pct(s.t1_changed.fresh, s.t1_changed.n)} of the changed facts) | ${bold(r.name, pct(s.t1.stale, s.t1.n))} |`);
  }
  return lines.join("\n");
}

export function overTimeTable(t) {
  const lines = [`| time since the edit | ${t.delays.map((d) => (d < 60 ? `${d} min` : `${d / 60} h`)).join(" | ")} |`, `| -- | ${t.delays.map(() => "--").join(" | ")} |`];
  for (const a of t.arms) {
    const name = a.every_minutes ? `an index re-synced every ${a.every_minutes} minutes, same ranking` : "**genter**, reading the docs at each question";
    lines.push(`| ${name} | ${a.by_delay.map((c) => (a.every_minutes ? `${pct(c.fresh, c.n)} · ${pct(c.stale, c.n)}` : `**${pct(c.fresh, c.n)} · ${pct(c.stale, c.n)}**`)).join(" | ")} |`);
  }
  return lines.join("\n");
}

export function takesTable(results) {
  const t = results.takes;
  const memory = armsOf(results).find((r) => r.name === "mem0" || r.name === "memory");
  const kept = `${t.store.body_lines.kept} of ${t.store.body_lines.total} lines of body text (${t.store.body_lines.bytes_kept} bytes); its headings`;
  const rows = [
    ["packages installed with it", t.packages.installed, memory?.info?.packages ?? "–"],
    ["model calls to take the docs in", t.model_calls_to_take_in, memory ? memory.model_calls_ingest : "–"],
    ["network connections · servers started", `${t.network.connections} · ${t.network.servers}`, memory ? "a model provider's API on every add and search" : "–"],
    [`from a cold start to the first answer (${t.docs.files} docs)`, duration(t.cold_add_to_first_answer_ms.median), memory ? `${duration(memory.ingest_ms)} to take the docs in` : "–"],
    ["median search", duration(t.search_ms.median), memory ? duration(median(memory.ask_ms)) : "–"],
    ["of the docs' text, it keeps", kept, memory?.info?.memories ? `${memory.info.memories} facts written by its model${memory.info.memory_bytes ? ` (${memory.info.memory_bytes} bytes)` : ""}` : "–"],
  ];
  const head = memory ? "| | **genter** | a memory that extracts facts with a model |\n| -- | -- | -- |" : "| | **genter** |\n| -- | -- |";
  return [head, ...rows.map(([what, g, m]) => (memory ? `| ${what} | **${g}** | ${m} |` : `| ${what} | **${g}** |`))].join("\n");
}

// The README block: the three tables and where they come from.
export function readmeBlock(results, file) {
  const date = results.at.slice(0, 10);
  const t = results.over_time;
  const out = [mainTable(results), ""];
  if (t) {
    out.push(
      `**Over time.** The same ${results.edits} edits land one by one, 2 to 30 minutes apart; each of the ${t.facts} changed facts is asked again some time after its edit. An index re-synced every N minutes is genter's own search over a copy of the docs taken every N minutes. Current answer · stale answer (${t.seeds} seeded timelines):`,
      "",
      overTimeTable(t),
      "",
    );
  }
  if (results.takes) {
    const s = results.takes.store;
    out.push(
      `**What it takes**, measured by \`bench/drift/takes.mjs\` (Node ${results.takes.node}, ${results.takes.platform}). The store keeps each file's place, title, headings, dates, size and a digest of its text, sealed: ${s.bytes} bytes for ${results.takes.docs.bytes} bytes of docs.`,
      "",
      takesTable(results),
      "",
    );
  }
  out.push(`[Results, ${date}](${file}).`);
  return out.join("\n");
}

export function replaceReadmeBlock(readme, block) {
  const start = "<!-- driftbench:start -->";
  const end = "<!-- driftbench:end -->";
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a < 0 || b < a) throw new Error("README has no driftbench block");
  return `${readme.slice(0, a + start.length)}\n${block}\n${readme.slice(b)}`;
}

// The numbers the README shows for genter (words only), for the weekly run to hold itself to.
export function readmeGenter(readme) {
  const row = readme.split("\n").find((l) => l.startsWith("| **genter** |"));
  const cells = row?.split("|").map((c) => c.trim());
  const num = (c) => Number(/(\d+)%/.exec(c ?? "")?.[1]);
  if (!cells || Number.isNaN(num(cells[4]))) throw new Error("README has no genter row in the driftbench block");
  return { t1_fresh: num(cells[4]), t1_stale: num(cells[5]) };
}

// The weekly run fails when genter answers anything stale after the edits, at any time, or its current share is more
// than `points` below the README's.
export function guard(results, readme, points = 5) {
  const problems = [];
  const g = results.rows.find((r) => r.name === "genter");
  const want = readmeGenter(readme);
  const fresh = (100 * g.score.t1.fresh) / g.score.t1.n;
  if (g.score.t1.stale > 0) problems.push(`genter answered ${g.score.t1.stale} stale facts after the edits`);
  if (fresh < want.t1_fresh - points) problems.push(`genter's current answers after the edits: ${fresh.toFixed(1)}%, the README says ${want.t1_fresh}%`);
  for (const c of results.over_time?.arms.find((a) => a.name === "genter")?.by_delay ?? []) {
    if (c.stale > 0) problems.push(`genter answered ${c.stale} stale facts ${c.minutes} minutes after their edit`);
  }
  return problems;
}

// The full report: every arm, per kind, over time, what it takes, and the methodology.
export function fullReport(results, { method = [] } = {}) {
  const rows = armsOf(results);
  const kinds = Object.keys(rows[0].score.kinds);
  const out = [`# DriftBench, ${results.at.slice(0, 10)}`, "", `${results.questions} questions, ${results.edits} edits, top ${results.k} passages.`, "", mainTable(results), ""];
  out.push(`| kind (n) | ${rows.map((r) => label(r.name)).join(" | ")} |`, `| -- | ${rows.map(() => "--").join(" | ")} |`);
  for (const k of kinds) out.push(`| ${k} (${rows[0].score.kinds[k].n}) | ${rows.map((r) => `${r.score.kinds[k].fresh} fresh · ${r.score.kinds[k].stale} stale`).join(" | ")} |`);
  out.push("", "| arm | after, unchanged facts | model calls to take the docs in | texts embedded | median search |", "| -- | -- | -- | -- | -- |");
  for (const r of rows) out.push(`| ${label(r.name)} | ${pct(r.score.t1_unchanged.fresh, r.score.t1_unchanged.n)} | ${r.model_calls_ingest ?? 0} | ${r.embedded ?? 0} | ${duration(median(r.ask_ms))} |`);
  const answered = results.rows.filter((r) => r.name.endsWith("→ answer"));
  if (answered.length) {
    out.push("", "Answers by a model from each arm's passages, judged by the same strings:", "", "| arm | before the edits | after: current answer | after: stale answer |", "| -- | -- | -- | -- |");
    for (const r of answered) out.push(`| ${label(r.name.replace(" → answer", ""))} | ${pct(r.score.t0.fresh, r.score.t0.n)} | ${pct(r.score.t1.fresh, r.score.t1.n)} | ${pct(r.score.t1.stale, r.score.t1.n)} |`);
  }
  if (results.over_time) {
    const t = results.over_time;
    out.push("", "## Over time", "", `The ${results.edits} edits land one by one, 2 to 30 minutes apart (the last ${t.edits_span_minutes} minutes after the docs went in, at most). Each of the ${t.facts} facts the edits change is asked again at each time after the edit that made its current answer. An index re-synced every N minutes is genter's own search over a copy of the docs taken every N minutes from the moment they went in: the same ranking, so only freshness differs. Current answer · stale answer, ${t.seeds} seeded timelines, ${t.facts * t.seeds} questions per cell:`, "", overTimeTable(t));
  }
  if (results.takes) {
    const k = results.takes;
    out.push("", "## What it takes", "", `Measured by \`bench/drift/takes.mjs\` on ${k.platform}, Node ${k.node}: ${k.cold_add_to_first_answer_ms.runs.length} cold runs of \`genter add\` then \`genter ask\` in new processes with no key in the environment (each run's time: ${k.cold_add_to_first_answer_ms.runs.join(", ")} ms), every network connection, name lookup and server counted in those processes, then ${k.search_ms.questions} searches in one process. The store was opened with its secret and searched for every line of the docs.`, "", takesTable(results), "", `- Store files: ${k.store.files.map((f) => `${f.file} (${f.bytes} bytes)`).join(", ")}; ${k.store.places} places; fields of a place: ${k.store.fields.join(", ")}.`, `- Headings kept: ${k.store.heading_lines.kept} of ${k.store.heading_lines.total} (${k.store.heading_lines.bytes_kept} bytes). Lines of body text kept: ${k.store.body_lines.kept} of ${k.store.body_lines.total} (lines of 20 characters or more).`, `- Network during the cold runs: ${k.network.connections} connections, ${k.network.lookups} name lookups, ${k.network.servers} servers, ${k.network.udp} UDP sockets.`);
  }
  if (method.length) out.push("", "## Methodology", "", ...method.map((m) => `- ${m}`));
  return `${out.join("\n")}\n`;
}
