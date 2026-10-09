// Ranking by words, with no model and no package: a tokenizer for English and Russian with a light stemmer, and BM25
// over sections with their headings counted higher. The local engine (local.js) ranks with it when no embeddings are
// at hand, and fuses it with them when they are.

const STOP = new Set(
  (
    "a an and are as at be been but by can do does did for from had has have how i if in into is it its me my no not of on or our " +
    "so than that the their them then there these they this to was we were what when where which who whom why will with you your " +
    "should would could about after before over under up down out also any all each just more most other some such only own same " +
    "very there here us he she his her hers him one get got use used using via per vs " +
    "и в во на с со к ко по о об от до из у за для не ни но а или ли же бы что как так это этот эта эти тот та те кто где когда " +
    "мне меня мы нас нам вы вас вам он она они оно его ее её их им ему ей при над под без про через уже еще ещё есть был была были быть"
  ).split(" "),
);

const RU_ENDINGS = ["иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "иях", "ах", "ях", "ов", "ев", "ей", "ой", "ий", "ый", "ая", "яя", "ое", "ее", "ую", "юю", "ом", "ем", "ам", "ям", "ия", "ие", "ию", "ть", "ться", "ет", "ут", "ют", "ит", "ат", "ят", "ы", "и", "а", "я", "о", "е", "у", "ю", "ь"].sort((a, b) => b.length - a.length);

// A word to its rough stem: "deployed", "deploys", "deploying" -> "deploy"; "release", "releases" -> "releas".
export function stem(word) {
  let w = word;
  if (/^[\p{N}]+$/u.test(w)) return w;
  if (/[а-яё]/.test(w)) {
    for (const e of RU_ENDINGS) if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length);
    return w;
  }
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(ch|sh|x|ss|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4) w = undouble(w.slice(0, -2));
  else if (w.endsWith("ation") && w.length > 7) w = w.slice(0, -3);
  else if (w.endsWith("ment") && w.length > 7) w = w.slice(0, -4);
  else if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}
const undouble = (w) => (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w) ? w.slice(0, -1) : w);

// The search terms of a text, in order: lowercased stems, stop words dropped; camelCase and snake_case also give their parts.
export function terms(text) {
  const out = [];
  for (const m of String(text ?? "").normalize("NFKC").matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    const parts = word.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u);
    for (const p of parts.length > 1 ? [word, ...parts] : [word]) {
      const lower = p.toLowerCase().replace(/ё/g, "е");
      if (STOP.has(lower)) continue;
      if (lower.length < 2 && !/^\p{N}$/u.test(lower)) continue;
      out.push(stem(lower));
    }
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;
const HEAD_WEIGHT = 2.5; // a word in a section's headings or file name counts this many times one in its text

// A document for bm25: { head, body } texts -> { tf: Map, len, pairs: Set } (pairs: adjacent terms of the text, for phrases).
export function prepare({ head = "", body = "" }) {
  const tf = new Map();
  const headTerms = terms(head);
  const bodyTerms = terms(body);
  for (const t of headTerms) tf.set(t, (tf.get(t) ?? 0) + HEAD_WEIGHT);
  for (const t of bodyTerms) tf.set(t, (tf.get(t) ?? 0) + 1);
  const pairs = new Set();
  for (let i = 1; i < bodyTerms.length; i++) pairs.add(`${bodyTerms[i - 1]} ${bodyTerms[i]}`);
  for (let i = 1; i < headTerms.length; i++) pairs.add(`${headTerms[i - 1]} ${headTerms[i]}`);
  return { tf, len: headTerms.length * HEAD_WEIGHT + bodyTerms.length, pairs };
}

// Scores of prepared documents for a query: BM25, then lifted by how much of the query's weight a document holds and
// by the query's word pairs found next to each other. Documents that share no term score 0.
export function bm25(query, docs) {
  const q = [...new Set(terms(query))];
  if (!q.length || !docs.length) return docs.map(() => 0);
  const n = docs.length;
  const avg = docs.reduce((s, d) => s + d.len, 0) / n || 1;
  const idf = new Map(
    q.map((t) => {
      const df = docs.reduce((s, d) => s + (d.tf.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
    }),
  );
  const total = q.reduce((s, t) => s + idf.get(t), 0) || 1;
  const qPairs = [];
  for (let i = 1; i < q.length; i++) qPairs.push([`${q[i - 1]} ${q[i]}`, Math.min(idf.get(q[i - 1]), idf.get(q[i]))]);
  return docs.map((d) => {
    let score = 0;
    let held = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      held += idf.get(t);
      score += (idf.get(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg));
    }
    if (!score) return 0;
    for (const [pair, w] of qPairs) if (d.pairs.has(pair)) score += 0.5 * w;
    return score * (0.5 + 0.5 * (held / total) ** 2);
  });
}

// The terms of a text that say most about it, with their counts: [[term, n]], at most `max` (a page's stored index).
export function topTerms(text, max = 150) {
  const tf = new Map();
  for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return [...tf].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
}
