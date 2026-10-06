import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNLOOP, cutLoop, loopIn, unlooped } from "../src/loop.js";

describe("Loops in a model's text", () => {
  it("finds a short piece written again and again, where it starts", () => {
    const text = `Каждый документ должен быть либо учебником, как-то${"-как".repeat(300)}`;
    assert.deepEqual(loopIn(text), { at: text.indexOf("-как"), piece: "-как" });
    assert.equal(cutLoop(text), "Каждый документ должен быть либо учебником…");
    assert.ok(loopIn("**Done** ".repeat(40)));
  });

  it("text that repeats a little is no loop", () => {
    for (const text of [
      "| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 |",
      `\`\`\`\n${"─".repeat(120)}\n\`\`\``,
      "**12** emails [1][2][3][4][5][6][7][8][9][10][11][12].",
      "- ✅\n".repeat(14),
      `Too long: ${" ".repeat(400)}spaces.`,
      "",
      null,
    ]) {
      assert.equal(loopIn(text), null, String(text));
      if (text) assert.equal(cutLoop(text), text);
    }
  });

  it("a text that is all loop is cut to nothing", () => {
    assert.equal(cutLoop("ok ".repeat(200)), "");
  });

  it("unlooped: a looped text is written once more, sampled and told the piece; looping again, it is cut", async () => {
    const looped = `Итого: ${"да-".repeat(100)}`;
    const calls = [];
    const write = (texts) => async (sampling, note) => (calls.push({ sampling, note }), texts.shift());
    assert.equal(await unlooped(write(["Итого: три письма."])), "Итого: три письма.");
    assert.deepEqual(calls, [{ sampling: undefined, note: undefined }]);
    calls.length = 0;
    assert.equal(await unlooped(write([looped, "Итого: да."])), "Итого: да.");
    assert.deepEqual(calls[1].sampling, UNLOOP);
    assert.match(calls[1].note, /it wrote "да-" again and again/);
    assert.equal(await unlooped(write([looped, looped])), "Итого…");
  });
});
