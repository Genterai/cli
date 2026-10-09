// LoCoMo and LongMemEval, the conversational-memory benchmarks mem0, Zep and Letta report on, run on Genter's local
// search: every session of a conversation is a Markdown file (a heading with its date, a section per few turns), the
// folder is added with `genter add`, and each question is asked with `genter ask`.
//
// Retrieval, with no key and no model: is the evidence among the passages Genter returns (LoCoMo: the turns the answer
// is in; LongMemEval: the sessions it is in), at 5 and at 10 passages.
// Answers (--answer, a key of any OpenAI-compatible provider): a model answers from the 10 passages and a model judge
// grades it with the benchmark's own prompt (LongMemEval's evaluate_qa.py; LoCoMo: mem0's llm_judge.py, gpt-4o-mini).
//
//   node bench/convo/run.mjs --download                 # LoCoMo (2.8 MB) and LongMemEval-S (277 MB) into ~/.cache/genter-bench
//   node bench/convo/run.mjs                            # retrieval on both, words only, no key
//   node bench/convo/run.mjs --semantic                 # + embeddings (OPENAI_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, Ollama)
//   node bench/convo/run.mjs --answer --limit 50        # + answers and the judge's verdict, on the first 50 questions of each
// Other flags: --only locomo|longmemeval, --data <dir>, --out <file>.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLocal, embedderFor, embeddingProvider } from "../../src/local.js";
import { chatModel, pool } from "../lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DATA = option("--data", join(homedir(), ".cache", "genter-bench"));
const LIMIT = Number(option("--limit", Infinity));
const ONLY = option("--only");
const SOURCES = {
  locomo: { file: "locomo10.json", url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" },
  longmemeval: { file: "longmemeval_s_cleaned.json", url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json" },
};
const TURNS_PER_SECTION = { locomo: 6, longmemeval: 2 };

// ---- data ----

async function download() {
  mkdirSync(DATA, { recursive: true });
  for (const [name, { file, url }] of Object.entries(SOURCES)) {
    const path = join(DATA, file);
    if (existsSync(path)) continue;
    process.stderr.write(`downloading ${name}…\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
}
const load = (name) => {
  const path = join(DATA, SOURCES[name].file);
  if (!existsSync(path)) throw new Error(`${path} is missing: node bench/convo/run.mjs --download`);
  return JSON.parse(readFileSync(path, "utf8"));
};

// A session as Markdown: its date in the heading, a section of a few turns each (so a passage is a few turns).
function sessionMarkdown(title, date, turns, per, line) {
  const out = [`# ${title} · ${date}`, ""];
  for (let i = 0; i < turns.length; i += per) {
    out.push(`## ${date} · turns ${i + 1}-${Math.min(turns.length, i + per)}`, "");
    for (const t of turns.slice(i, i + per)) out.push(line(t), "");
  }
  return out.join("\n");
}

// LoCoMo: one corpus per conversation; questions of categories 1-4 (5, adversarial, is left out as in published runs).
function locomoCases() {
  return load("locomo").map((c) => {
    const conv = c.conversation;
    const files = {};
    for (let n = 1; conv[`session_${n}`]; n++) {
      const turns = conv[`session_${n}`];
      const line = (t) => `**${t.speaker}** [${t.dia_id}]: ${t.text}${t.blip_caption ? ` [shares a photo: ${t.blip_caption}]` : ""}`;
      files[`session_${String(n).padStart(2, "0")}.md`] = sessionMarkdown(`Session ${n}`, conv[`session_${n}_date_time`], turns, TURNS_PER_SECTION.locomo, line);
    }
    const questions = c.qa
      .filter((q) => q.category !== 5)
      .map((q) => ({ question: q.question, answer: String(q.answer), type: `category ${q.category}`, evidence: (q.evidence ?? []).flatMap((e) => String(e).split(/[;,\s]+/)).filter((e) => /^D\d+:\d+$/.test(e)) }));
    return { id: c.sample_id, files, questions };
  });
}

// LongMemEval-S: one corpus per question (its own ~48 sessions); abstention questions are kept for answers only.
function longmemevalCases() {
  return load("longmemeval").map((q) => {
    const files = {};
    q.haystack_sessions.forEach((turns, i) => {
      const id = q.haystack_session_ids[i];
      const line = (t) => `**${t.role}:** ${t.content}`;
      files[`${String(i).padStart(3, "0")}_${id.replace(/[^\w-]/g, "_")}.md`] = sessionMarkdown(`Session ${id}`, q.haystack_dates[i], turns, TURNS_PER_SECTION.longmemeval, line);
    });
    const abstention = q.question_id.endsWith("_abs");
    return {
      id: q.question_id,
      files,
      questions: [{ question: q.question, answer: String(q.answer), type: q.question_type, date: q.question_date, abstention, sessions: abstention ? [] : q.answer_session_ids.map((s) => s.replace(/[^\w-]/g, "_")) }],
    };
  });
}

// ---- retrieval ----

async function retrieve(cases, { embed }) {
  const out = [];
  let asked = 0;
  for (const c of cases) {
    if (asked >= LIMIT) break;
    const base = mkdtempSync(join(tmpdir(), "convo-"));
    const dir = join(base, "sessions");
    mkdirSync(dir);
    for (const [name, text] of Object.entries(c.files)) writeFileSync(join(dir, name), text);
    const local = createLocal({ home: join(base, "home"), secret: "bench", cwd: base, embed });
    await local.add(dir);
    for (const q of c.questions) {
      if (asked++ >= LIMIT) break;
      const started = Date.now();
      const found = await local.find(q.question, { limit: 10 });
      out.push({ case: c.id, ...q, ms: Date.now() - started, passages: found.results.map((r) => ({ file: basename(r.path), text: r.text })) });
    }
    rmSync(base, { recursive: true, force: true });
  }
  return out;
}

function recall(rows, k) {
  const scored = rows.filter((r) => (r.evidence ?? r.sessions)?.length);
  const hits = scored.map((r) => {
    const top = r.passages.slice(0, k);
    const wanted = r.evidence ?? r.sessions;
    const got = r.evidence ? wanted.filter((e) => top.some((p) => p.text.includes(`[${e}]`))) : wanted.filter((s) => top.some((p) => p.file.includes(s)));
    return { any: got.length > 0, all: got.length === wanted.length, type: r.type };
  });
  const share = (xs, key) => (xs.length ? xs.filter((h) => h[key]).length / xs.length : null);
  const types = [...new Set(hits.map((h) => h.type))].sort();
  return { n: hits.length, any: share(hits, "any"), all: share(hits, "all"), types: Object.fromEntries(types.map((t) => [t, { n: hits.filter((h) => h.type === t).length, any: share(hits.filter((h) => h.type === t), "any"), all: share(hits.filter((h) => h.type === t), "all") }])) };
}

// ---- answers ----

const LME_JUDGE = {
  default: "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  "temporal-reasoning": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  "knowledge-update": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  "single-session-preference": "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {q}\n\nRubric: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  abstention: "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {q}\n\nExplanation: {a}\n\nModel Response: {r}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.",
};
const LOCOMO_JUDGE = `
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it’s time for the real question:
Question: {q}
Gold answer: {a}
Generated answer: {r}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
`;

async function answer(bench, rows, m) {
  return pool(rows, 8, async (r) => {
    const context = r.passages.map((p, i) => `[${i + 1}] (${p.file})\n${p.text.slice(0, 2500)}`).join("\n\n");
    const prompt =
      bench === "locomo"
        ? `Answer the question about the two people's past conversations from these excerpts of them (each session has its date in its heading). Answer in a few words. For a question about when, give the date or period, worked out from the session's date when the excerpt says "yesterday" or "last week".\n\n${context}\n\nQuestion: ${r.question}\nAnswer:`
        : `These are excerpts of past chat sessions between a user and an assistant, each under its date. Today is ${r.date}. Answer the user's question from them; if they do not hold the answer, say you do not know. When facts changed over time, answer with the latest.\n\n${context}\n\nQuestion: ${r.question}\nAnswer:`;
    const response = await m.chat(m.reader, prompt).catch((e) => `error: ${e.message}`);
    const judged =
      bench === "locomo"
        ? await m.chat(m.judge, LOCOMO_JUDGE.replace("{q}", r.question).replace("{a}", r.answer).replace("{r}", response), true).then((t) => /CORRECT/.test(JSON.parse(t).label ?? t)).catch(() => false)
        : await m.chat(m.judge, (r.abstention ? LME_JUDGE.abstention : (LME_JUDGE[r.type] ?? LME_JUDGE.default)).replace("{q}", r.question).replace("{a}", r.answer).replace("{r}", response)).then((t) => /\byes\b/i.test(t)).catch(() => false);
    return { ...r, response, correct: judged };
  });
}

function accuracy(rows) {
  const types = [...new Set(rows.map((r) => (r.abstention ? "abstention" : r.type)))].sort();
  const share = (xs) => (xs.length ? xs.filter((r) => r.correct).length / xs.length : null);
  return { n: rows.length, correct: share(rows), types: Object.fromEntries(types.map((t) => [t, { n: rows.filter((r) => (r.abstention ? "abstention" : r.type) === t).length, correct: share(rows.filter((r) => (r.abstention ? "abstention" : r.type) === t)) }])) };
}

// ---- main ----

const pct = (x) => (x == null ? "–" : `${(100 * x).toFixed(1)}%`);

async function main() {
  if (flag("--download")) return download();
  const embed = flag("--semantic") ? embedderFor(embeddingProvider({ env: process.env })) : undefined;
  const arm = embed ? `genter --semantic (${embed.provider} ${embed.model})` : "genter (words, no key)";
  const report = { at: new Date().toISOString(), arm, limit: Number.isFinite(LIMIT) ? LIMIT : null, benches: {} };
  const lines = [`Conversational memory benchmarks · ${arm} · ${report.at.slice(0, 10)}`, ""];
  for (const [bench, cases] of [["locomo", locomoCases], ["longmemeval", longmemevalCases]]) {
    if (ONLY && ONLY !== bench) continue;
    process.stderr.write(`${bench}: retrieving…\n`);
    const started = Date.now();
    const rows = await retrieve(cases(), { embed });
    const r5 = recall(rows, 5);
    const r10 = recall(rows, 10);
    const median = [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    report.benches[bench] = { questions: rows.length, seconds: Math.round((Date.now() - started) / 1000), median_ms: median, recall_at_5: r5, recall_at_10: r10 };
    const what = bench === "locomo" ? "evidence turns" : "evidence sessions";
    lines.push(`${bench === "locomo" ? "LoCoMo" : "LongMemEval-S"}: ${rows.length} questions, ${what} among the passages (any / all), median search ${median} ms`, "");
    lines.push("| | @5 any | @5 all | @10 any | @10 all |", "| -- | -- | -- | -- | -- |");
    lines.push(`| all (${r5.n}) | ${pct(r5.any)} | ${pct(r5.all)} | ${pct(r10.any)} | ${pct(r10.all)} |`);
    for (const t of Object.keys(r5.types)) lines.push(`| ${t} (${r5.types[t].n}) | ${pct(r5.types[t].any)} | ${pct(r5.types[t].all)} | ${pct(r10.types[t].any)} | ${pct(r10.types[t].all)} |`);
    lines.push("");
    if (flag("--answer")) {
      const m = chatModel();
      process.stderr.write(`${bench}: answering with ${m.provider} ${m.reader}, judged by ${m.judge}…\n`);
      const answered = await answer(bench, rows, m);
      const acc = accuracy(answered);
      report.benches[bench].answers = { provider: m.provider, reader: m.reader, judge: m.judge, ...acc };
      lines.push(`Answers from the 10 passages (${m.reader}, judged by ${m.judge} with the benchmark's prompt): ${pct(acc.correct)} of ${acc.n}`, "");
      lines.push("| type | correct |", "| -- | -- |", ...Object.entries(acc.types).map(([t, v]) => `| ${t} (${v.n}) | ${pct(v.correct)} |`), "");
      report.benches[bench].rows = answered.map(({ passages, ...r }) => r);
    }
  }
  console.log(lines.join("\n"));
  const file = option("--out");
  if (file) writeFileSync(file, JSON.stringify(report, null, 2));
}

await main();
