// gpt-oss at temperature 0 now and then falls into a loop: it writes one short piece again and again until its token
// limit. A docs question got "…каждый документ должен быть либо учебником, как-то-как-как-как-…" over whole screens
// ("how-to" in Russian, then "-как" for ever). Such text is never shown: it is written again once, sampled (UNLOOP) and
// told where it looped (loopNote), and when that loops too it is cut where the loop starts (cutLoop).

// A piece of up to 40 characters repeated 15+ times in a row over 200+ characters is a loop. A table's |---|---| rule,
// a line of ─ in a code block or a short run of the same mark stay well under that.
const LOOP = /([\s\S]{1,40}?)\1{14,}/gu;
const LOOP_MIN = 200;

// Where the first loop of a text starts and the piece it repeats, or null. Blank runs are no loop: Markdown drops them.
export function loopIn(text) {
  for (const m of String(text ?? "").matchAll(LOOP)) if (m[0].length >= LOOP_MIN && /\S/u.test(m[1])) return { at: m.index, piece: m[1] };
  return null;
}

// The text up to its first loop, without the word the loop began in, ending with "…"; the text itself when it has no
// loop, "" when it is all loop.
export function cutLoop(text) {
  const loop = loopIn(text);
  if (!loop) return text;
  const kept = text
    .slice(0, loop.at)
    .replace(/\S*$/u, "")
    .replace(/[\s,;:–—-]+$/u, "");
  return kept ? `${kept}…` : "";
}

// How a text that looped is written again: sampled, as gpt-oss is meant to run (at temperature 0 it takes the same turn
// into the loop every time), with a penalty on repeated tokens where the provider takes one (Groq ignores it).
export const UNLOOP = { temperature: 1, frequency_penalty: 0.3 };

// What the model is told before it writes a looped text again, so it goes another way where it looped.
export const loopNote = (piece) =>
  `Your answer fell into a loop: it wrote "${piece.trim()}" again and again until it was cut off. ` +
  "Write the whole answer again; where it looped, use other words and go on with the answer.";

// Text of one model call, never a loop: write(sampling, note) makes the call (with those settings and that note to the
// model, both undefined the first time) and returns its text. A text that loops is written again once; looping again, it
// is cut where the loop starts.
export async function unlooped(write) {
  const text = await write();
  const loop = loopIn(text);
  return loop ? cutLoop(await write(UNLOOP, loopNote(loop.piece))) : text;
}
