import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAgent } from "../src/agent.js";
import { cipher } from "../src/genter.js";
import { agentResultText, agentTools } from "../src/tools.js";
import { answer, briefingOf, call, catalogues, fakeGenter, fakeModel, lastOf, memoryRuns } from "./helpers.js";

let model;
afterEach(() => model?.restore());

const agentWith = (genter, options = {}) => createAgent({ genter, openrouterApiKey: "test", secret: "s", userId: "u", runs: memoryRuns(), ...options });

// A chunk of the synced genter-cli project, as genter.knowledge returns it.
const chunk = {
  source: "src_1",
  source_title: "Genterai/genter-cli",
  toolkit: "github",
  part: "files",
  item: "src/sync.js",
  tool: "GITHUB_GET_A_TREE",
  title: "src/sync.js",
  url: "https://github.com/Genterai/genter-cli/blob/main/src/sync.js",
  where: { owner: "Genterai", repo: "genter-cli", branch: "main", path: "src/sync.js", sha: "s1" },
  text: "// A page shorter than the page size asked for is the last one: no call for an empty page after it.",
  score: 0.62,
};

describe("GitHub project: find, see the cited paths, write there", () => {
  it("A1 a find answered from synced knowledge returns the cited file with where it is and how to write there", async () => {
    const genter = fakeGenter({ connected: ["github"], knowledge: [chunk] });
    model = fakeModel([answer("Paging stops at the first page shorter than the page size [1].")]);
    const out = await agentWith(genter).start({ task: "when does paging stop in genter-cli?", mode: "find" });

    assert.match(briefingOf(model.requests[0]), /"ref":1,"source":"Genterai\/genter-cli"/);
    assert.match(model.requests[0].messages[0].content, /Cite where each fact comes from/);
    assert.equal(out.status, "done");
    const [ref] = out.references;
    assert.deepEqual(
      { n: ref.n, kind: ref.kind, path: ref.path, where: ref.where, via: ref.via },
      { n: 1, kind: "file", path: "src/sync.js", where: { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" }, via: "knowledge" },
    );
    assert.equal(ref.write[0].tool, "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS");

    const text = agentResultText(out, { write: true });
    assert.match(text, /References:\n\[1\] github file Genterai\/genter-cli\/src\/sync\.js — https:\/\/github\.com\/Genterai\/genter-cli\/blob\/main\/src\/sync\.js/);
    assert.match(text, /where \{"owner":"Genterai","repo":"genter-cli","path":"src\/sync\.js","branch":"main"\}/);
    assert.match(text, /edit  \{edits: \[\{find, replace\}\], message\}: one commit, only those pieces change\n    write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS\(message, content\)/);
    assert.match(text, /GENTER_WRITE \{run_id, ref: n, change\}/);
    assert.doesNotMatch(agentResultText(out), /write GITHUB_/); // without GENTER_WRITE: references only
  });

  // The synced file as GitHub's contents API returns it.
  const contents = (text, sha = "s1") => ({ content: { path: "src/sync.js", sha, content: Buffer.from(text).toString("base64"), encoding: "base64" } });
  const file = "// paging\nconst limit = 10;\nexport default limit;\n";
  const findThenAgent = async (results) => {
    const genter = fakeGenter({ connected: ["github"], knowledge: [chunk], results });
    const agent = agentWith(genter);
    model = fakeModel([answer("Paging stops at a short page [1].")]);
    const found = await agent.start({ task: "when does paging stop?", mode: "find" });
    model.restore();
    return { genter, agent, found };
  };
  const committed = (genter) => {
    const commit = genter.executed.find((e) => e.tool === "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS");
    return commit && { ...commit, text: Buffer.from(commit.args.content, "base64").toString() };
  };

  it("A2 write at [1] of that find: the agent sends only the pieces to change, the file is read and committed once", async () => {
    const { genter, agent, found } = await findThenAgent({ GITHUB_GET_REPOSITORY_CONTENT: contents(file), GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS: { commit: { sha: "c2", html_url: "https://github.com/Genterai/genter-cli/commit/c2" } } });
    let note;
    model = fakeModel([
      (body) => {
        note = lastOf(body, "user");
        return call("edit_file", { ref: 1, edits: [{ find: "const limit = 10;", replace: "const limit = 20;" }], message: "Raise the page limit" });
      },
      (body) => {
        assert.deepEqual(JSON.parse(lastOf(body, "tool")), { ref: 1, committed: true, summary: "1 edit committed to Genterai/genter-cli/src/sync.js (4 → 4 lines)", commit: "https://github.com/Genterai/genter-cli/commit/c2" });
        return answer("Raised the limit to 20 in src/sync.js [1]: https://github.com/Genterai/genter-cli/commit/c2");
      },
    ]);
    const out = await agent.write({ run_id: found.run_id, ref: 1, change: "raise the page limit to 20" });

    assert.match(note, /^Write at \[1\]: github file Genterai\/genter-cli\/src\/sync\.js \(https:\/\/github\.com\/Genterai\/genter-cli\/blob\/main\/src\/sync\.js\)/);
    assert.match(note, /Change this file with edit_file \{ref: 1, edits: \[\{find: .*never write the whole file out/);
    assert.match(note, /read the file first: GITHUB_GET_REPOSITORY_CONTENT \{"owner":"Genterai","repo":"genter-cli","path":"src\/sync\.js","ref":"main"\}/);
    assert.match(note, /Change: raise the page limit to 20/);
    // Read, then one commit of the whole new text at the sha it was read at; neither saved as a recipe.
    assert.deepEqual(genter.executed.map((e) => [e.tool, e.remember]), [["GITHUB_GET_REPOSITORY_CONTENT", false], ["GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", false]]);
    const commit = committed(genter);
    assert.equal(commit.text, "// paging\nconst limit = 20;\nexport default limit;\n");
    assert.deepEqual({ ...commit.args, content: undefined }, { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main", message: "Raise the page limit", sha: "s1", content: undefined });
    assert.equal(out.status, "done");
    assert.equal(out.run_id, found.run_id);
    assert.equal(out.references[0].path, "src/sync.js");
  });

  it("A2b GENTER_WRITE with edits: one commit with no model step; a find that is not there commits nothing", async () => {
    const { genter, agent, found } = await findThenAgent({ GITHUB_GET_REPOSITORY_CONTENT: contents(file), GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS: { commit: { html_url: "https://github.com/Genterai/genter-cli/commit/c3" } } });
    model = fakeModel([]); // any model call fails the test
    const out = await agent.write({ run_id: found.run_id, ref: 1, edits: [{ append: "// see README\n" }], message: "Point to the README" });
    assert.equal(out.status, "done");
    assert.equal(out.usage.llm_calls, 0);
    assert.equal(out.answer, "1 edit committed to Genterai/genter-cli/src/sync.js (4 → 5 lines). Commit: https://github.com/Genterai/genter-cli/commit/c3");
    assert.equal(committed(genter).text, `${file}// see README\n`);

    genter.executed.length = 0;
    const missed = await agent.write({ run_id: found.run_id, ref: 1, edits: [{ find: "const limit = 99;", replace: "x" }], message: "m" });
    assert.equal(missed.status, "failed");
    assert.match(missed.answer, /^Not committed: edit 1: find is not in the file; lines like it: 2: "const limit = 10;"/);
    assert.deepEqual(genter.executed.map((e) => e.tool), ["GITHUB_GET_REPOSITORY_CONTENT"]);
  });

  it("A2c a find never edits: edit_file is refused there like any write", async () => {
    const genter = fakeGenter({ connected: ["github"], knowledge: [chunk] });
    model = fakeModel([
      call("edit_file", { ref: 1, edits: [{ append: "x" }], message: "m" }),
      (body) => {
        assert.match(lastOf(body, "tool"), /^Not allowed: editing a file changes it and this is a read-only find/);
        return answer("I can only read here [1].");
      },
    ]);
    await agentWith(genter).start({ task: "add x to src/sync.js", mode: "find" });
    assert.equal(genter.executed.length, 0);
  });

  it("A3 write at a link with no run: a new run starts with the place and its write tools in the briefing", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_CREATE_AN_ISSUE_COMMENT: { id: 5, html_url: "https://github.com/Genterai/genter-cli/issues/42#issuecomment-5" } } });
    model = fakeModel([
      (body) => {
        assert.match(briefingOf(body), /Write at \[1\]: github issue Genterai\/genter-cli #42/);
        assert.match(briefingOf(body), /- GITHUB_CREATE_AN_ISSUE_COMMENT \{"owner":"Genterai","repo":"genter-cli","issue_number":42\} \+ body/);
        return call("execute", { tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", args: { owner: "Genterai", repo: "genter-cli", issue_number: 42, body: "Fixed in #43" } });
      },
      answer("Commented on #42 [1]."),
    ]);
    const out = await agentWith(genter).write({ ref: "https://github.com/Genterai/genter-cli/issues/42", change: "comment: Fixed in #43" });
    assert.equal(out.status, "done");
    assert.deepEqual(genter.executed[0].args, { owner: "Genterai", repo: "genter-cli", issue_number: 42, body: "Fixed in #43" });
    assert.equal(out.references[0].kind, "issue");
  });
});

describe("Not GitHub: every app writes with its own tools", () => {
  const mail = {
    messages: [
      { messageId: "18c1", threadId: "18c0", subject: "Contract", sender: "Anna Petrova <anna@acme.com>", messageText: "Can we sign on Thursday?" },
      { messageId: "18c2", threadId: "18b9", subject: "Invoice", sender: "billing@vendor.io", messageText: "Attached." },
    ],
  };

  it("A4 Gmail: items of a list result are citable; an exact reply runs at once with the thread and sender filled in", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results: { GMAIL_FETCH_EMAILS: mail, GMAIL_REPLY_TO_THREAD: { id: "18c3", threadId: "18c0" } } });
    const runs = memoryRuns();
    const agent = agentWith(genter, { runs });
    model = fakeModel([
      call("execute", { tool: "GMAIL_FETCH_EMAILS", args: { query: "from:anna", max_results: 20 } }),
      (body) => {
        const result = JSON.parse(lastOf(body, "tool"));
        assert.deepEqual(JSON.parse(result.data).messages.map((m) => m._ref), [1, 2]);
        return answer("Anna asks to sign the contract on Thursday [1].");
      },
    ]);
    const found = await agent.start({ task: "what did Anna write about the contract?", mode: "find" });
    const [email] = found.references;
    assert.deepEqual(email.where, { message_id: "18c1", thread_id: "18c0", from: "anna@acme.com" });
    assert.equal(email.write[0].tool, "GMAIL_REPLY_TO_THREAD");
    // The stored run keeps no email text, only which number is which email.
    const stored = cipher("s:u:runs").open(runs.rows.get(found.run_id).blob);
    const kept = JSON.parse(stored.messages.find((m) => m.role === "tool").content);
    assert.deepEqual(kept.items, [[1, "Contract"], [2, "Invoice"]]);
    assert.equal(kept.data, undefined);

    const calls = model.requests.length;
    const out = await agent.write({ run_id: found.run_id, ref: "[1]", tool: "GMAIL_REPLY_TO_THREAD", args: { message_body: "Thursday works." } });
    assert.equal(model.requests.length, calls, "an exact write makes no model call");
    assert.deepEqual(genter.executed.at(-1).args, { thread_id: "18c0", recipient_email: "anna@acme.com", message_body: "Thursday works." });
    assert.equal(out.status, "done");
    assert.equal(out.usage.llm_calls, 0);
    assert.match(out.answer, /^Done: GMAIL_REPLY_TO_THREAD at Contract\./);
  });

  it("A5 Linear (no known tools): the write tools come from Linear's own catalogue, the issue's id in issueId", async () => {
    const { tool, args, data } = catalogues.linear.list;
    const genter = fakeGenter({ connected: ["linear"], catalogs: { linear: catalogues.linear.tools }, results: { [tool]: data, LINEAR_CREATE_LINEAR_COMMENT: { comment: { id: "cm1" } } } });
    const agent = agentWith(genter);
    model = fakeModel([call("execute", { tool, args }), answer("ENG-142 Retry webhook delivery is in progress [1].")]);
    const found = await agent.start({ task: "what is assigned to me in linear?", mode: "find" });
    const [issue] = found.references;
    const issueId = data.issues[0].id;
    assert.equal(issue.kind, "issue");
    assert.deepEqual(issue.write.slice(0, 2).map((h) => [h.tool, h.args]), [
      ["LINEAR_UPDATE_ISSUE", { issueId }],
      ["LINEAR_CREATE_LINEAR_COMMENT", { issueId }],
    ]);
    assert.match(agentResultText(found, { write: true }), /write LINEAR_UPDATE_ISSUE\(title\?, description\?\) · LINEAR_CREATE_LINEAR_COMMENT\(body\)/);

    model.restore();
    model = fakeModel([
      (body) => {
        assert.match(lastOf(body, "user"), new RegExp(`- LINEAR_CREATE_LINEAR_COMMENT \\{"issueId":"${issueId}"\\} \\+ body`));
        return call("execute", { tool: "LINEAR_CREATE_LINEAR_COMMENT", args: { issueId, body: "On it" } });
      },
      answer("Commented on ENG-142 [1]."),
    ]);
    const out = await agent.write({ run_id: found.run_id, ref: 1, change: "comment: On it" });
    assert.equal(out.status, "done");
    assert.deepEqual(genter.executed.at(-1), { id: undefined, tool: "LINEAR_CREATE_LINEAR_COMMENT", args: { issueId, body: "On it" }, account: undefined });
  });

  it("A6 a catalogue that does not load in time leaves the reference without hints; write finds them then", async () => {
    const { tool, args, data } = catalogues.slack.list;
    const genter = fakeGenter({ connected: ["slack"], results: { [tool]: data } });
    let slow = true;
    genter.catalog = async () => (slow ? new Promise((resolve) => setTimeout(resolve, 3000, catalogues.slack.tools)) : catalogues.slack.tools);
    const agent = agentWith(genter);
    model = fakeModel([call("execute", { tool, args }), answer("Staging deploy is blocked on the payments migration [1].")]);
    const found = await agent.start({ task: "what's new in #releases?", mode: "find" });
    assert.deepEqual(found.references[0].write, []);

    slow = false;
    const out = await agent.write({ run_id: found.run_id, ref: 1, tool: "SLACK_SEND_MESSAGE", args: { markdown_text: "Billing is on it" } });
    assert.equal(out.status, "failed"); // no fake result for it: what matters is the args it was called with
    assert.deepEqual(genter.executed.at(-1).args, { channel: "C07QX2M4B1F", thread_ts: data.messages[0].ts, markdown_text: "Billing is on it" });
  });

  it("A7 an answer without marks: the references are what it names", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results: { GMAIL_FETCH_EMAILS: mail } });
    model = fakeModel([call("execute", { tool: "GMAIL_FETCH_EMAILS", args: { query: "newer_than:1d" } }), answer("One email: Invoice, from billing.")]);
    const out = await agentWith(genter).start({ task: "today's emails", mode: "find" });
    assert.deepEqual(out.references.map((r) => r.title), ["Invoice"]);
  });
});

describe("Writes that are refused", () => {
  it("A8 a reference number needs its run, an unknown one says which exist, a tool must be of the reference's app", async () => {
    const genter = fakeGenter({ connected: ["github"], knowledge: [chunk] });
    const agent = agentWith(genter);
    model = fakeModel([answer("See [1].")]);
    const found = await agent.start({ task: "paging", mode: "find" });
    await assert.rejects(agent.write({ ref: 1, change: "x" }), /pass the run_id/);
    await assert.rejects(agent.write({ run_id: found.run_id, ref: 7, change: "x" }), /has no reference \[7\]; it has \[1\]\.\.\[1\]/);
    await assert.rejects(agent.write({ run_id: found.run_id, ref: 1, tool: "SLACK_SEND_MESSAGE", args: {} }), /not a github tool/);
    await assert.rejects(agent.write({ run_id: found.run_id, ref: 1 }), /Pass change/);
    await assert.rejects(agent.write({ edits: [{ append: "x" }], message: "m" }), /Pass ref/);
    await assert.rejects(agent.write({ ref: "https://example.com/x", change: "x" }), /Unknown place/);
    assert.equal(genter.executed.length, 0);
  });

  it("A9 a viewer can find and see references, but not write", async () => {
    const genter = fakeGenter({ connected: ["github"], knowledge: [chunk] });
    const agent = agentWith(genter, { canExecute: false });
    model = fakeModel([answer("See [1].")]);
    const found = await agent.start({ task: "paging", mode: "find" });
    assert.equal(found.references.length, 1);
    await assert.rejects(agent.write({ run_id: found.run_id, ref: 1, tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", args: { message: "m", content: "c" } }), /can search but not run tools/);
  });

  it("A10 GENTER_WRITE is in the MCP tools only where writing is on", () => {
    assert.ok(!("GENTER_WRITE" in agentTools()));
    const tool = agentTools({ write: true }).GENTER_WRITE;
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual(tool.input.parse({ run_id: "r", ref: 3, change: "x" }), { run_id: "r", ref: 3, change: "x" });
    assert.deepEqual(tool.input.parse({ ref: "https://github.com/a/b/issues/1", tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", args: { body: "hi" } }).args, { body: "hi" });
    assert.deepEqual(tool.input.parse({ run_id: "r", ref: 1, edits: [{ find: "a", replace: "b" }, { append: "c" }], message: "m" }).edits, [{ find: "a", replace: "b" }, { append: "c" }]);
  });
});
