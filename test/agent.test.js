import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAgent } from "../src/agent.js";
import { cipher } from "../src/genter.js";
import { actionInstructions, agentInstructions, agentResultText, agentTools, readable, readQuestion, recipesResultText } from "../src/tools.js";
import { answer, briefingOf, call, catalogues, fakeGenter, fakeModel, lastOf, memoryRuns } from "./helpers.js";

let model;
afterEach(() => model?.restore());

const agentWith = (genter, options = {}) => createAgent({ genter, openrouterApiKey: "test", secret: "s", userId: "u", runs: memoryRuns(), ...options });

// The file of genter-cli a find reads first: its reference [1] is what the writes below point at.
const FILE = "// paging\nconst limit = 10;\nexport default limit;\n";
const fileResult = (text = FILE, sha = "s1") => ({ content: { path: "src/sync.js", sha, content: Buffer.from(text).toString("base64"), encoding: "base64" } });
const COMMITS = { id: "rcp_commits", tool: "GITHUB_LIST_COMMITS", args: { owner: "Genterai", repo: "genter-cli" }, title: "Recent commits of Genterai/genter-cli", short: "Recent commits", summary: "20 commits", status: "fresh", score: 0.8 };
const readFirst = (text) => [call("read_file", { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" }), answer(text)];

describe("GitHub file: find, see the cited paths, write there", () => {
  it("A1 a find that read a file returns the cited file with where it is and how to write there", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_REPOSITORY_CONTENT: fileResult() } });
    model = fakeModel(readFirst("Paging stops at the first page shorter than the page size [1]."));
    const out = await agentWith(genter).start({ task: "when does paging stop in genter-cli?", mode: "find" });

    assert.match(model.requests[0].messages[0].content, /Cite where each fact comes from/);
    assert.equal(out.status, "done");
    const [ref] = out.references;
    assert.deepEqual(
      { n: ref.n, kind: ref.kind, path: ref.path, where: ref.where, via: ref.via },
      { n: 1, kind: "file", path: "src/sync.js", where: { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" }, via: "call" },
    );
    assert.equal(ref.write[0].tool, "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS");

    const text = agentResultText(out, { write: true });
    assert.match(text, /References:\n\[1\] github file Genterai\/genter-cli\/src\/sync\.js\n/);
    assert.match(text, /where \{"owner":"Genterai","repo":"genter-cli","path":"src\/sync\.js","branch":"main"\}/);
    // A follow-up that reads the place in full, for the client's model (as Search asks when a source is clicked).
    assert.match(text, /\n {4}read {2}GENTER_FIND \{"question":"Read the github file \\"Genterai\/genter-cli\/src\/sync\.js\\" in full/);
    assert.match(text, /edit {2}\{edits: \[\{find, replace\}\], message\}: one commit, only those pieces change\n {4}write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS\(message, content\)/);
    assert.match(text, /GENTER_WRITE \{run_id, ref: n, change\}/);
    assert.doesNotMatch(agentResultText(out), /write GITHUB_/); // without GENTER_WRITE: references only
  });

  const contents = fileResult;
  const file = FILE;
  const findThenAgent = async (results) => {
    const genter = fakeGenter({ connected: ["github"], results });
    const agent = agentWith(genter);
    model = fakeModel(readFirst("Paging stops at a short page [1]."));
    const found = await agent.start({ task: "when does paging stop?", mode: "find" });
    model.restore();
    genter.executed.length = 0;
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

    assert.match(note, /^Write at \[1\]: github file Genterai\/genter-cli\/src\/sync\.js\n/);
    assert.match(note, /Change this file with edit_file \{ref: 1, edits: \[\{find: .*never write the whole file out/);
    assert.match(note, /read the file first: GITHUB_GET_REPOSITORY_CONTENT \{"owner":"Genterai","repo":"genter-cli","path":"src\/sync\.js","ref":"main"\}/);
    assert.match(note, /Change: raise the page limit to 20/);
    // Read, then one commit of the whole new text at the sha it was read at; neither saved as an anchor.
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
    const genter = fakeGenter({ connected: ["github"] });
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
    const genter = fakeGenter({ connected: ["github"], recipes: [COMMITS] });
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
    const genter = fakeGenter({ connected: ["github"], recipes: [COMMITS] });
    const agent = agentWith(genter, { canExecute: false });
    model = fakeModel([answer("See [1].")]);
    const found = await agent.start({ task: "paging", mode: "find" });
    assert.equal(found.references.length, 1);
    await assert.rejects(agent.write({ run_id: found.run_id, ref: 1, tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", args: { message: "m", content: "c" } }), /can search but not run tools/);
  });

  it("A10 GENTER_WRITE is in the MCP tools only where actions are on", () => {
    assert.ok(!("GENTER_WRITE" in agentTools()));
    const tool = agentTools({ actions: true }).GENTER_WRITE;
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual(tool.input.parse({ run_id: "r", ref: 3, change: "x" }), { run_id: "r", ref: 3, change: "x" });
    assert.deepEqual(tool.input.parse({ ref: "https://github.com/a/b/issues/1", tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", args: { body: "hi" } }).args, { body: "hi" });
    assert.deepEqual(tool.input.parse({ run_id: "r", ref: 1, edits: [{ find: "a", replace: "b" }, { append: "c" }], message: "m" }).edits, [{ find: "a", replace: "b" }, { append: "c" }]);
  });
});

describe("A person's instructions from their workspace", () => {
  it("P1 they follow the fixed system prompt in every call of every round; without them there is only the system prompt", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results: { GMAIL_FETCH_EMAILS: { messages: [{ messageId: "1", subject: "Hi" }] } } });
    const agent = agentWith(genter, { instructions: "  Answer in Russian.\nSign emails as Anna.  " });
    model = fakeModel([call("execute", { tool: "GMAIL_FETCH_EMAILS", args: {} }), answer("Одно письмо."), answer("Готово.")]);
    const found = await agent.start({ task: "today's emails", mode: "find" });
    await agent.send({ run_id: found.run_id, message: "and yesterday?" });
    for (const body of model.requests) {
      const system = body.messages.filter((m) => m.role === "system");
      assert.equal(system.length, 2);
      assert.match(system[0].content, /Cite where each fact comes from/);
      assert.match(system[1].content, /<instructions>\nAnswer in Russian\.\nSign emails as Anna\.\n<\/instructions>/);
    }
    model.restore();
    model = fakeModel([answer("Nothing.")]);
    await agentWith(genter, { instructions: "   " }).start({ task: "today's emails", mode: "find" });
    assert.equal(model.requests[0].messages.filter((m) => m.role === "system").length, 1);
  });
});

describe("An app connected several times", () => {
  // Two GitHub accounts: Docsbook-io/docs is only visible to the second one.
  const twoAccounts = () => {
    const genter = fakeGenter({});
    const executed = genter.executed;
    const readme = "# Changelog\n\n## 1.0\n";
    genter.login = async () => ({
      connected: [
        { toolkit: "github", account: "ca_main", alias: "Main", default: true, status: "ACTIVE" },
        { toolkit: "github", account: "ca_two", alias: "Connection 2", status: "ACTIVE" },
      ],
    });
    genter.execute = async ({ tool, args = {}, account, remember }) => {
      executed.push({ tool, args, account, ...(remember === false && { remember }) });
      if (args.owner === "Docsbook-io" && account !== "ca_two") return { result: { successful: false, error: "Not Found (404)" } };
      if (tool === "GITHUB_GET_REPOSITORY_CONTENT") {
        return { id: "rec_1", result: { successful: true, data: { content: { path: "CHANGELOG.md", sha: "s1", content: Buffer.from(readme).toString("base64"), encoding: "base64" } } } };
      }
      return { result: { successful: true, data: { commit: { html_url: "https://github.com/Docsbook-io/docs/commit/c1" } } } };
    };
    return genter;
  };
  const where = { owner: "Docsbook-io", repo: "docs", path: "CHANGELOG.md" };

  it("M1 what the default account cannot see is read on the other one, and the edit commits there too", async () => {
    const genter = twoAccounts();
    model = fakeModel([
      call("execute", { tool: "GITHUB_GET_REPOSITORY_CONTENT", args: where }),
      (body) => {
        const result = JSON.parse(lastOf(body, "tool"));
        assert.equal(result.successful, true);
        assert.equal(result.account, "Connection 2");
        return call("edit_file", { ...where, edits: [{ find: "## 1.0", replace: "## 1.1\n\n## 1.0" }], message: "Changelog 1.1" });
      },
      answer("Added 1.1 to the changelog (Connection 2) [1]."),
    ]);
    const out = await agentWith(genter).start({ task: "add 1.1 to the changelog of Docsbook-io/docs" });
    assert.equal(out.status, "done");
    assert.deepEqual(
      genter.executed.map((e) => [e.tool, e.account]),
      [
        ["GITHUB_GET_REPOSITORY_CONTENT", undefined],
        ["GITHUB_GET_REPOSITORY_CONTENT", "ca_two"],
        ["GITHUB_GET_REPOSITORY_CONTENT", "ca_two"], // edit_file reads on the account found, no default try
        ["GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", "ca_two"],
      ],
    );
  });

  it("M2 a GENTER_WRITE edit by link finds the account by itself", async () => {
    const genter = twoAccounts();
    const out = await agentWith(genter).write({ ref: "https://github.com/Docsbook-io/docs/blob/main/CHANGELOG.md", edits: [{ find: "## 1.0", replace: "## 1.1\n\n## 1.0" }], message: "m" });
    assert.equal(out.status, "done");
    assert.deepEqual(genter.executed.map((e) => e.account), [undefined, "ca_two", "ca_two"]);
  });

  it("M4 an account that can read but not push: the commit goes to the one that can", async () => {
    const genter = twoAccounts();
    const read = genter.execute;
    genter.execute = async (input) => {
      if (input.tool === "GITHUB_GET_REPOSITORY_CONTENT") return read({ ...input, account: "ca_two" }).then((out) => (genter.executed.at(-1).account = input.account, out));
      if (input.account !== "ca_two") {
        genter.executed.push({ tool: input.tool, account: input.account });
        return { result: { successful: false, error: "Resource not accessible by integration (403)" } };
      }
      return read(input);
    };
    const out = await agentWith(genter).write({ ref: "https://github.com/Docsbook-io/docs/blob/main/CHANGELOG.md", edits: [{ find: "## 1.0", replace: "## 1.1\n\n## 1.0" }], message: "m" });
    assert.equal(out.status, "done");
    assert.deepEqual(genter.executed.map((e) => [e.tool, e.account]), [
      ["GITHUB_GET_REPOSITORY_CONTENT", undefined],
      ["GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", undefined],
      ["GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", "ca_two"],
    ]);
  });

  it("M3 an account the user named is not second-guessed", async () => {
    const genter = twoAccounts();
    model = fakeModel([call("execute", { tool: "GITHUB_GET_REPOSITORY_CONTENT", args: where, account: "Main" }), answer("Not found.")]);
    await agentWith(genter).start({ task: "read the changelog of Docsbook-io/docs" });
    assert.deepEqual(genter.executed.map((e) => e.account), ["Main"]);
  });
});

describe("A write that writes nothing", () => {
  const contents = (text) => ({ content: { path: "src/sync.js", sha: "s1", content: Buffer.from(text).toString("base64"), encoding: "base64" } });
  const found = async (results) => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_REPOSITORY_CONTENT: fileResult(), ...results } });
    const agent = agentWith(genter);
    model = fakeModel(readFirst("Paging [1]."));
    const run = await agent.start({ task: "paging", mode: "find" });
    model.restore();
    genter.executed.length = 0;
    return { genter, agent, run };
  };

  it("W1 an empty ending is sent back once to write, then the edit is committed", async () => {
    const { genter, agent, run } = await found({ GITHUB_GET_REPOSITORY_CONTENT: contents("a\nb\n"), GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS: { commit: { html_url: "https://github.com/x/y/commit/c" } } });
    model = fakeModel([
      answer(""),
      (body) => {
        assert.match(lastOf(body, "user"), /Nothing has been written yet/);
        return call("edit_file", { ref: 1, edits: [{ find: "b", replace: "c" }], message: "m" });
      },
      answer("Committed [1]."),
    ]);
    const out = await agent.write({ run_id: run.run_id, ref: 1, change: "b -> c" });
    assert.equal(out.status, "done");
    assert.equal(genter.executed.at(-1).tool, "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS");
  });

  it("W2 no write at all is a failure, never Done", async () => {
    const { agent, run } = await found({});
    model = fakeModel([answer(""), answer("")]);
    const out = await agent.write({ run_id: run.run_id, ref: 1, change: "b -> c" });
    assert.equal(out.status, "failed");
    assert.match(out.answer, /Nothing was written/);
  });
});

describe("Reading files: a built-in read, never 'there is no tool'", () => {
  const commits = { id: "rec_commits", tool: "GITHUB_LIST_COMMITS", args: { owner: "Genterai", repo: "genter-cli" }, description: "### Recent commits of Genterai/genter-cli", summary: "20 commits", status: "valid", score: 0.8 };
  const text = "export const a = 1;\nexport const b = 2;\n";
  const results = {
    GITHUB_GET_REPOSITORY_CONTENT: ({ path }) =>
      path === "src" ? { content: [{ path: "src/agent.js", type: "file" }, { path: "src/lib", type: "dir" }] } : { content: { path, sha: "s1", content: Buffer.from(text).toString("base64"), encoding: "base64" } },
  };

  it("R1 read_file reads a file by owner, repo and path in a find: its text, a file reference, nothing saved as an anchor", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results });
    model = fakeModel([
      call("read_file", { owner: "Genterai", repo: "genter-cli", path: "/src/agent.js", branch: "main" }),
      (body) => {
        const out = JSON.parse(lastOf(body, "tool"));
        assert.equal(out.ref, 2); // [1] is the commits anchor
        assert.equal(out.text, text);
        assert.equal(out.lines, 3);
        return answer("src/agent.js exports a and b [2].");
      },
    ]);
    const out = await agentWith(genter).start({ task: "последние коммиты в genter-cli и прочитай src/agent.js", mode: "find" });
    assert.equal(out.status, "done");
    assert.deepEqual(genter.executed, [{ id: undefined, tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "Genterai", repo: "genter-cli", path: "src/agent.js", ref: "main" }, account: undefined, remember: false }]);
    assert.deepEqual(out.references.map((r) => [r.n, r.kind, r.where.path]), [[2, "file", "src/agent.js"]]);
    assert.match(model.requests[0].messages[0].content, /call read_file/);
    assert.ok(model.requests[0].tools.some((t) => t.function.name === "read_file"));
  });

  it("R2 a folder gives its entries; a missing file is an error the model can act on", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results });
    model = fakeModel([
      call("read_file", { owner: "Genterai", repo: "genter-cli", path: "src" }),
      (body) => {
        assert.deepEqual(JSON.parse(lastOf(body, "tool")).folder, ["src/agent.js", "src/lib/"]);
        return call("read_file", { owner: "Genterai", repo: "nope", path: "x.js" });
      },
      (body) => {
        assert.match(lastOf(body, "tool"), /Could not read/);
        return answer("Done [2].");
      },
    ]);
    genter.execute = ((execute) => async (input) => (input.args.repo === "nope" ? { result: { successful: false, error: "Not Found" } } : execute(input)))(genter.execute);
    const out = await agentWith(genter).start({ task: "что в папке src genter-cli", mode: "find" });
    assert.equal(out.status, "done");
  });

  it("R3 an answer that gives up for want of a tool is sent back once, on the strong model, and the file is read", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results });
    model = fakeModel([
      answer("Коммиты: ... К сожалению, в текущем наборе инструментов нет команды, позволяющей прочитать содержимое файла."),
      (body) => {
        assert.match(lastOf(body, "user"), /Do not give up on a part of the task/);
        assert.equal(body.model, "strong");
        return call("read_file", { owner: "Genterai", repo: "genter-cli", path: "src/agent.js" });
      },
      answer("Коммиты [1]; src/agent.js экспортирует a и b [2]."),
    ]);
    const out = await agentWith(genter, { model: "fast", strongModel: "strong" }).start({ task: "свежие коммиты genter-cli и прочитай изменённые файлы", mode: "find" });
    assert.equal(model.requests[0].model, "fast");
    assert.equal(out.status, "done");
    assert.match(out.answer, /экспортирует/);
    assert.equal(genter.executed.at(-1).tool, "GITHUB_GET_REPOSITORY_CONTENT");
  });

  it("R4 giving up again after the push back is the answer: no loop", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results });
    model = fakeModel([answer("No tool can read files."), answer("Could not read the files: the repository is archived.")]);
    const out = await agentWith(genter).start({ task: "read the files of genter-cli", mode: "find" });
    assert.equal(out.status, "done");
    assert.equal(model.requests.length, 2);
  });

  it("R5 a viewer cannot read files", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results });
    model = fakeModel([call("read_file", { owner: "Genterai", repo: "genter-cli", path: "a.js" }), answer("Only anchors [1].")]);
    await agentWith(genter, { canExecute: false }).start({ task: "read a.js", mode: "find" });
    assert.match(lastOf(model.requests[1], "tool"), /Not allowed/);
    assert.equal(genter.executed.length, 0);
  });
});

describe("A task of several parts on an anchor of one: the tools of the other parts are found", () => {
  const commits = { id: "rec_commits", tool: "GITHUB_LIST_COMMITS", args: { owner: "Genterai", repo: "genter-cli" }, description: "### Recent commits of Genterai/genter-cli", summary: "20 commits", status: "valid", score: 0.8 };
  const file = { content: { path: "src/agent.js", sha: "s1", content: Buffer.from("const a = 1;\n").toString("base64"), encoding: "base64" } };

  it("P1 search_tools asks for Composio tools even when an anchor fits well", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits] });
    const asked = [];
    genter.search = async (input) => (asked.push(input), [commits]);
    model = fakeModel([call("search_tools", { query: "GITHUB_GET_COMMIT" }), answer("Commits [1].")]);
    await agentWith(genter).start({ task: "recent commits and their files", mode: "find" });
    assert.equal(asked.at(-1).tools, true);
    assert.equal(asked[0].tools, undefined); // the briefing's search stays anchor-first
  });

  it("P2 read_file with a commit's ref and a path reads that path in the commit's repository; '' and the app's name are no account", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results: { GITHUB_LIST_COMMITS: [{ sha: "c1" }], GITHUB_GET_REPOSITORY_CONTENT: file } });
    model = fakeModel([
      call("execute", { id: "rec_commits" }),
      call("read_file", { ref: 1, path: "src/agent.js", branch: "", account: "github" }),
      (body) => {
        assert.equal(JSON.parse(lastOf(body, "tool")).text, "const a = 1;\n");
        return answer("Read [2].");
      },
    ]);
    const out = await agentWith(genter).start({ task: "recent commits and their files", mode: "find" });
    assert.deepEqual(genter.executed.at(-1), { id: undefined, tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "Genterai", repo: "genter-cli", path: "src/agent.js" }, account: undefined, remember: false });
    assert.equal(out.references[0].where.path, "src/agent.js");
  });

  it("P3 an execute with no tool and no id is an error that moves the run to the strong model", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits] });
    model = fakeModel([
      call("execute", { args: { owner: "Genterai" } }),
      (body) => {
        assert.match(lastOf(body, "tool"), /Pass tool/);
        assert.equal(body.model, "strong");
        return answer("Commits [1].");
      },
    ]);
    await agentWith(genter, { model: "fast", strongModel: "strong" }).start({ task: "recent commits", mode: "find" });
    assert.equal(genter.executed.length, 0);
  });

  it("P4 an empty ending after a read is asked for the answer once, never a bare Done", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results: { GITHUB_LIST_COMMITS: [{ sha: "c1" }] } });
    model = fakeModel([
      call("execute", { id: "rec_commits" }),
      answer(""),
      (body) => {
        assert.match(lastOf(body, "user"), /You ended without an answer/);
        return answer("The latest commit is c1 [1].");
      },
    ]);
    const out = await agentWith(genter).start({ task: "recent commits", mode: "find" });
    assert.equal(out.answer, "The latest commit is c1 [1].");
  });
});

describe("No answer is never Done", () => {
  it("N1 empty twice after a read: the second try is on the strong model, then a failure that names what ran, with no references", async () => {
    const commits = { id: "rec_commits", tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" }, description: "### Recent commits", summary: "20 commits", status: "valid", score: 0.8 };
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results: { GITHUB_LIST_COMMITS: [{ sha: "c1" }] } });
    model = fakeModel([call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } }), answer(""), (body) => (assert.equal(body.model, "strong"), answer(""))]);
    const out = await agentWith(genter, { model: "fast", strongModel: "strong" }).start({ task: "recent commits", mode: "find" });
    assert.equal(out.status, "failed");
    assert.match(out.answer, /ran GITHUB_LIST_COMMITS but gave no answer/);
    assert.equal(out.references, undefined);
  });
});

describe("Anchors in the agent", () => {
  const stepsOf = (out) => out.steps.map((s) => s.recipe);

  it("N2 every executed step says what happened to its anchor, and the result lists saved and recipes_used", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_LIST_COMMITS: [{ sha: "a" }] } });
    model = fakeModel([call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } }), answer("One commit.")]);
    const out = await agentWith(genter).start({ task: "recent commits of o/r", mode: "find" });
    assert.deepEqual(stepsOf(out), [{ id: "rcp_1", created: true, changed: false }]);
    assert.equal(out.steps[0].saved, "rcp_1"); // the older field stays
    assert.deepEqual(out.saved, [{ id: "rcp_1", created: true, changed: false }]);
    assert.deepEqual(out.recipes_used, ["rcp_1"]);
  });

  it("N3 the prompt: an anchor says which call to make, the real tool is always executed, calls are saved automatically", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [COMMITS] });
    model = fakeModel([answer("ok")]);
    await agentWith(genter).start({ task: "recent commits", mode: "find" });
    const system = model.requests[0].messages[0].content;
    assert.match(system, /ALWAYS execute the real tool/);
    assert.match(system, /NOT the current value/);
    assert.match(system, /saved as an anchor automatically/);
    assert.doesNotMatch(system, /add_source|build_live_sync|search_knowledge|live sync/);
    const names = model.requests[0].tools.map((t) => t.function.name);
    for (const gone of ["add_source", "build_live_sync", "sync_source", "search_knowledge", "save_recipes"]) assert.ok(!names.includes(gone), gone);
    assert.ok(names.includes("suggest_prepare"));
    assert.ok(!names.includes("read_many") && !names.includes("read_each") && !names.includes("recheck_recipe")); // modes only
    // No tool's name begins with another's: gpt-oss on Groq broke "execute_many" into "execute<|channel|>...".
    for (const a of names) for (const b of names) assert.ok(a === b || !b.startsWith(a), `${b} begins with ${a}`);
    // A free-form args object has no type: Groq wrote an object with no listed properties as {}.
    const execute = model.requests[0].tools.find((t) => t.function.name === "execute").function.parameters.properties.args;
    assert.equal(execute.type, undefined);
    assert.match(briefingOf(model.requests[0]), /last_result/);
  });

  it("N4 suggest_prepare records a suggestion and has no side effects", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_A_TREE: { tree: [] } } });
    model = fakeModel([call("suggest_prepare", { label: "Entire repository o/r", why: "many files" }), answer("Done.")]);
    const out = await agentWith(genter).start({ task: "what is in o/r?", mode: "find" });
    assert.deepEqual(out.suggestions, [{ label: "Entire repository o/r" }]);
    assert.equal(genter.executed.length, 0);
  });

  it("N5 a prepare task fans out reads with read_many (4 at a time, max 100) and finishes with counts; writes are skipped", async () => {
    let running = 0;
    let peak = 0;
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_REPOSITORY_CONTENT: ({ path }) => ({ path }) } });
    const original = genter.execute;
    genter.execute = async (input) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return original(input);
    };
    const calls = Array.from({ length: 130 }, (_, i) => ({ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path: `f${i}` } }));
    calls.push({ tool: "GITHUB_CREATE_AN_ISSUE", args: {} });
    model = fakeModel([
      call("read_many", { calls }),
      (body) => {
        const counts = JSON.parse(lastOf(body, "tool"));
        assert.equal(counts.requested, 100);
        assert.equal(counts.ok, 100);
        assert.equal(counts.created, 100);
        return answer("");
      },
    ]);
    const out = await agentWith(genter).start({ task: "Prepare entire repository o/r", mode: "prepare" });
    assert.equal(peak, 4);
    assert.equal(genter.executed.length, 100);
    assert.equal(out.status, "done");
    assert.match(out.answer, /Prepared 100 reads: 100 new anchors, 0 updated, 0 unchanged, 0 failed/);
    assert.equal(out.saved.length, 100);
  });

  it("N6 read_many, read_each (and their old names) are refused outside a prepare task", async () => {
    const genter = fakeGenter({ connected: ["github"] });
    model = fakeModel([
      call("read_many", { calls: [{ tool: "GITHUB_LIST_COMMITS" }] }),
      call("execute_many", { calls: [{ tool: "GITHUB_LIST_COMMITS" }] }),
      call("read_each", { list_id: "x", read_tool: "GITHUB_GET_REPOSITORY_CONTENT", item_arg: "path" }),
      answer("no"),
    ]);
    await agentWith(genter).start({ task: "x", mode: "run" });
    assert.equal(genter.executed.length, 0);
  });

  it("N5b read_each reads every item a list call listed, one anchor each, leaving out folders and files with no text", async () => {
    const tree = { sha: "t", truncated: false, tree: [
      ...Array.from({ length: 150 }, (_, i) => ({ path: `src/f${i}.js`, type: "blob", sha: `s${i}` })),
      { path: "src", type: "tree", sha: "d1" }, { path: "img/logo.png", type: "blob", sha: "p" }, { path: "package-lock.json", type: "blob", sha: "l" },
    ] };
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_A_TREE: tree, GITHUB_GET_REPOSITORY_CONTENT: ({ path }) => ({ path, content: "x" }) } });
    model = fakeModel([
      call("execute", { tool: "GITHUB_GET_A_TREE", args: { owner: "o", repo: "r", tree_sha: "main", recursive: true } }),
      (body) => {
        const listed = JSON.parse(lastOf(body, "tool"));
        assert.equal(listed.listed, 153);
        assert.match(listed.next, /read_each/);
        assert.match(listed.data, /truncated/); // the model sees part of the list; read_each takes all of it
        // Called through execute, the way gpt-oss does it: it is read_each all the same.
        return call("execute", { tool: "read_each", args: { list_id: listed.id, read_tool: "GITHUB_GET_REPOSITORY_CONTENT", shared_args: { owner: "o", repo: "r" }, item_arg: "path" } });
      },
      (body) => {
        const counts = JSON.parse(lastOf(body, "tool"));
        assert.equal(counts.requested, 150);
        assert.equal(counts.created, 150);
        return answer("");
      },
    ]);
    const out = await agentWith(genter).start({ task: "Read the whole github repository o/r", mode: "prepare" });
    const reads = genter.executed.filter((e) => e.tool === "GITHUB_GET_REPOSITORY_CONTENT");
    assert.equal(reads.length, 150);
    assert.deepEqual(reads[0].args, { owner: "o", repo: "r", path: "src/f0.js" });
    assert.ok(!reads.some((r) => /png|lock|^src$/.test(r.args.path)));
    assert.match(out.answer, /Prepared 150 reads: 150 new anchors/);
    assert.equal(out.saved.length, 151); // the tree and every file
    // How the area was read goes with the run, so it can be listed again and compared with no model (area.js).
    assert.equal(out.listing.recipe_id, "rcp_1");
    assert.equal(out.listing.read_tool, "GITHUB_GET_REPOSITORY_CONTENT");
    assert.deepEqual(out.listing.shared_args, { owner: "o", repo: "r" });
    assert.equal(out.listing.item_arg, "path");
    assert.equal(out.listing.item_field, "path");
    assert.equal(Object.keys(out.listing.versions).length, 150);
    assert.equal(out.listing.versions["src/f7.js"], "s7"); // the sha the tree gave the file
  });

  it("N5d [spec:area-listing/run-reads] [spec:area-listing/listing-handed-early] [spec:area-listing/plain-reads] a run reads no more than `reads`, plainly, and hands its listing over as it goes", async () => {
    const tree = { sha: "t", truncated: false, tree: Array.from({ length: 80 }, (_, i) => ({ path: `f${i}.md`, type: "blob", sha: `s${i}` })) };
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_A_TREE: tree, GITHUB_GET_REPOSITORY_CONTENT: ({ path }) => ({ path, content: "x" }) } });
    const handed = [];
    model = fakeModel([
      call("execute", { tool: "GITHUB_GET_A_TREE", args: { owner: "o", repo: "r", recursive: true } }),
      (body) => call("read_each", { list_id: JSON.parse(lastOf(body, "tool")).id, read_tool: "GITHUB_GET_REPOSITORY_CONTENT", shared_args: { owner: "o", repo: "r" }, item_arg: "path" }),
      (body) => {
        const counts = JSON.parse(lastOf(body, "tool"));
        assert.equal(counts.requested, 60);
        assert.equal(counts.not_read, 20);
        assert.match(counts.note, /room for items kept whole is used up/);
        return call("read_many", { calls: [{ tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "o", repo: "r", path: "x.md" } }] });
      },
      (body) => {
        assert.match(JSON.parse(lastOf(body, "tool")).error, /room for items kept whole is used up/);
        return answer("");
      },
    ]);
    const out = await agentWith(genter, { onListing: (l) => handed.push(Object.keys(l.versions).length) }).start({ task: "Read the whole github repository o/r", mode: "prepare", reads: 60 });
    const reads = genter.executed.filter((e) => e.tool === "GITHUB_GET_REPOSITORY_CONTENT");
    assert.equal(reads.length, 60);
    assert.ok(reads.every((r) => r.plain === true));
    assert.ok(!genter.executed.find((e) => e.tool === "GITHUB_GET_A_TREE").plain); // the list call is an ordinary one
    assert.ok(handed.length >= 3 && handed[0] >= 25 && handed[0] < 60); // while reading (other reads go on meanwhile)
    assert.equal(handed.at(-1), 60); // and at the end
    assert.equal(out.listing.listed, 80);
  });

  it("N5c read_each with no list, args written as JSON text, and an empty execute in a prepare task get the way to do it", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_LIST_FILES: { files: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, GITHUB_GET_FILE: ({ file_id }) => ({ file_id }) } });
    model = fakeModel([
      call("read_each", { list_id: "nope", read_tool: "GITHUB_GET_FILE", item_arg: "file_id" }),
      (body) => {
        assert.match(JSON.parse(lastOf(body, "tool")).error, /No list to read/);
        return call("execute", { tool: "GITHUB_LIST_FILES", args: '{"folder_id": "f1"}' });
      },
      (body) => {
        assert.equal(JSON.parse(lastOf(body, "tool")).listed, 2);
        return call("execute", {});
      },
      (body) => {
        assert.match(JSON.parse(lastOf(body, "tool")).hint, /read_each/);
        return call("read_each", { list_id: "whatever", read_tool: "GITHUB_GET_FILE", shared_args: "{}", item_arg: "file_id" });
      },
      answer(""),
    ]);
    await agentWith(genter).start({ task: "Read the whole folder f1", mode: "prepare" });
    assert.deepEqual(genter.executed[0].args, { folder_id: "f1" }); // JSON text read as the object it says
    assert.deepEqual(genter.executed.slice(1).map((e) => e.args), [{ file_id: "a" }, { file_id: "b" }]); // items without file_id: their id
  });

  it("N7 an event task rechecks only the affected anchors and forgets what was deleted; it never writes", async () => {
    const genter = fakeGenter({ connected: ["github"] });
    model = fakeModel([
      call("recheck_recipe", { id: "rcp_a_changed" }),
      call("forget_recipe", { id: "rcp_b", reason: "file deleted" }),
      call("execute", { tool: "GITHUB_CREATE_AN_ISSUE", args: {} }),
      answer("rcp_a changed, rcp_b forgotten."),
    ]);
    const out = await agentWith(genter).start({ task: "Event github push in o/r. Affected anchors: rcp_a_changed, rcp_b", mode: "event" });
    assert.deepEqual(genter.rechecked, ["rcp_a_changed"]);
    assert.deepEqual(genter.gone, ["rcp_b"]);
    assert.equal(genter.executed.length, 0); // the write was refused
    assert.deepEqual(out.steps.find((s) => s.tool === "recheck_recipe").recipe, { id: "rcp_a_changed", created: false, changed: true });
    assert.deepEqual(model.requests[0].tools.map((t) => t.function.name).filter((n) => ["recheck_recipe", "forget_recipe"].includes(n)), ["recheck_recipe", "forget_recipe"]);
    assert.match(briefingOf(model.requests[0]), /Mode: event/);
  });
});

describe("The anchors an answer rests on: its references name them, and only they keep the request", () => {
  const results = { GITHUB_LIST_REPOSITORIES: [{ name: "genter-cli", full_name: "Genterai/genter-cli" }], GITHUB_LIST_COMMITS: [{ sha: "a1", message: "Fix paging" }, { sha: "b2", message: "Add search" }] };
  const twoCalls = (text) => [call("execute", { tool: "GITHUB_LIST_REPOSITORIES", args: {} }), call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "Genterai", repo: "genter-cli" } }), answer(text)];

  it("R1 each reference carries the anchor whose call showed it; answer_recipes are the cited ones, and only they keep the request", async () => {
    const genter = fakeGenter({ connected: ["github"], results });
    model = fakeModel(twoCalls("Latest: **Fix paging** [2], before it Add search [3]."));
    const out = await agentWith(genter).start({ task: "recent commits of genter-cli", mode: "find" });
    assert.equal(out.status, "done");
    assert.deepEqual(out.references.map((r) => [r.n, r.recipe]), [[2, "rcp_2"], [3, "rcp_2"]]);
    assert.deepEqual(out.answer_recipes, ["rcp_2"]); // the repository list only found the name
    assert.deepEqual(genter.asked, [{ ids: ["rcp_2"], task: "recent commits of genter-cli" }]);
    assert.ok(genter.executed.every((e) => e.task === undefined), "no call files the request by itself");
  });

  it("R2 mode anchors: the results handed over are the answer's anchors", async () => {
    const genter = fakeGenter({ connected: ["github"], results });
    model = fakeModel(twoCalls("rcp_2"));
    const out = await agentWith(genter).start({ task: "recent commits of genter-cli", mode: "recipes" });
    assert.deepEqual(out.answer_recipes, ["rcp_2"]);
    assert.deepEqual(genter.asked, [{ ids: ["rcp_2"], task: "recent commits of genter-cli" }]);
  });

  it("R3 a prepare run keeps no request: its task is an instruction, not a question", async () => {
    const genter = fakeGenter({ connected: ["github"], results });
    model = fakeModel(twoCalls("Read 2 [2]."));
    await agentWith(genter).start({ task: "Read every file of Genterai/genter-cli", mode: "prepare" });
    assert.deepEqual(genter.asked, []);
  });
});

describe("Mode anchors (MCP GENTER_FIND): the run hands over raw results of anchors, no written answer", () => {
  const MAIL = { messages: [{ id: "m1", subject: "Contract draft", from: "anna@x.com" }, { id: "m2", subject: "Re: contract", from: "anna@x.com", snippet: "Please sign by Friday" }] };
  const results = { GMAIL_FETCH_EMAILS: MAIL, GITHUB_LIST_REPOSITORIES: [{ name: "genter-cli" }], GITHUB_LIST_COMMITS: [{ sha: "a1", message: "Fix paging" }], GMAIL_SEND_EMAIL: { id: "sent" } };

  it("M1 the calls the model names come back as they came (items with _ref), its words do not; nothing raw is stored", async () => {
    const runs = memoryRuns();
    const genter = fakeGenter({ connected: ["gmail"], results });
    model = fakeModel([call("execute", { tool: "GMAIL_FETCH_EMAILS", args: { query: "from:anna contract" } }), answer("rcp_1")]);
    const out = await agentWith(genter, { runs }).start({ task: "what did Anna write about the contract?", mode: "recipes" });
    assert.equal(out.status, "done");
    assert.equal(out.results.length, 1);
    const [r] = out.results;
    assert.equal(r.id, "rcp_1");
    assert.equal(r.tool, "GMAIL_FETCH_EMAILS");
    assert.deepEqual(r.args, { query: "from:anna contract" });
    assert.deepEqual(r.data.messages.map((m) => m.subject), ["Contract draft", "Re: contract"]);
    assert.deepEqual(r.data.messages.map((m) => m._ref), [1, 2]);
    assert.deepEqual(out.references.map((x) => x.n), [1, 2]);
    assert.match(briefingOf(model.requests[0]), /Mode: anchors/);
    assert.match(briefingOf(model.requests[0]), /Write NO answer/);
    assert.match(briefingOf(model.requests[0]), /joins several things .* run the anchors of each/);
    const stored = JSON.stringify(cipher("s:u:runs").open(runs.rows.get(out.run_id).blob));
    assert.doesNotMatch(stored, /sign by Friday/);
    assert.equal(r.data.messages[1].snippet, "Please sign by Friday");
    // Each email of the list can be read in full with the call its reference names; the list itself is here already.
    const text = recipesResultText(out);
    assert.match(text, /\[1\] gmail \S+ Contract draft\n( {4}where .*\n)? {4}read {2}GENTER_FIND \{"question":"Read the gmail \S+ \\"Contract draft\\" in full/);
    assert.match(agentInstructions, /"read" line is the GENTER_FIND call that reads that place in full/);
  });

  it("M2 a call made only to find a name is left out when the model names the one that answers", async () => {
    const genter = fakeGenter({ connected: ["github"], results });
    model = fakeModel([
      call("execute", { tool: "GITHUB_LIST_REPOSITORIES", args: {} }),
      call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "genter-cli" } }),
      answer("rcp_2"),
    ]);
    const out = await agentWith(genter).start({ task: "recent commits of genter-cli", mode: "recipes" });
    assert.deepEqual(out.results.map((r) => r.tool), ["GITHUB_LIST_COMMITS"]);
    assert.deepEqual(out.saved.map((s) => s.id), ["rcp_1", "rcp_2"]); // both are anchors all the same
  });

  it("M3 no ids named (a model that ends with no text): every result of the round that held something, empty ones left out", async () => {
    const genter = fakeGenter({ connected: ["github", "gmail"], results: { ...results, GMAIL_LIST_DRAFTS: { drafts: [] } } });
    model = fakeModel([
      { content: null, tool_calls: [...call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } }).tool_calls, ...call("execute", { tool: "GMAIL_LIST_DRAFTS", args: {} }).tool_calls] },
      answer(""),
    ]);
    const out = await agentWith(genter).start({ task: "what changed", mode: "recipes" });
    assert.equal(out.status, "done");
    assert.deepEqual(out.results.map((r) => r.tool), ["GITHUB_LIST_COMMITS"]);
    assert.equal(model.requests.length, 2); // not asked again for an answer
  });

  it("M4 a saved anchor the model names without running it is run now, so its result is current", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [COMMITS], results });
    model = fakeModel([answer("rcp_commits")]);
    const out = await agentWith(genter).start({ task: "recent commits", mode: "recipes" });
    assert.deepEqual(genter.executed.map((e) => [e.id, e.tool]), [["rcp_commits", "GITHUB_LIST_COMMITS"]]);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].from, "rcp_commits");
    assert.deepEqual(out.results[0].data.map((c) => c.sha), ["a1"]);
  });

  it("M5 read-only: a write is refused; nothing found: the model's one line comes back, with no results", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results });
    model = fakeModel([call("execute", { tool: "GMAIL_SEND_EMAIL", args: { to: "a@x.com" } }), answer("Checked Gmail: nothing about it.")]);
    const out = await agentWith(genter).start({ task: "email anna", mode: "recipes" });
    assert.equal(genter.executed.length, 0);
    assert.deepEqual(out.results, []);
    assert.equal(out.answer, "Checked Gmail: nothing about it.");
    const text = recipesResultText(out);
    assert.match(text, /^Checked Gmail: nothing about it\./);
    assert.deepEqual(JSON.parse(text.slice(text.lastIndexOf("\n") + 1)).recipes, []);
  });

  it("M6 read_file is saved as an anchor here, and the file comes back decoded", async () => {
    const text = "export const a = 1;\n";
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_REPOSITORY_CONTENT: ({ path }) => ({ content: { path, sha: "s1", content: Buffer.from(text).toString("base64"), encoding: "base64" } }) } });
    model = fakeModel([
      call("read_file", { owner: "o", repo: "r", path: "src/a.js" }),
      (body) => {
        assert.equal(JSON.parse(lastOf(body, "tool")).id, "rcp_1");
        return answer("rcp_1");
      },
    ]);
    const out = await agentWith(genter).start({ task: "read src/a.js of o/r", mode: "recipes" });
    assert.equal(genter.executed[0].remember, undefined); // saved, unlike in a find
    assert.deepEqual(out.results.map((r) => r.id), ["rcp_1"]);
    assert.deepEqual(out.saved, [{ id: "rcp_1", created: true, changed: false }]);
    assert.equal(readable(out.results[0].data).content.content, text);
    assert.match(recipesResultText(out), /"content":"export const a = 1;\\n"/);
  });

  it("M7 the model failing at the end loses nothing that was read", async () => {
    const genter = fakeGenter({ connected: ["github"], results });
    model = fakeModel([call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } })]); // the second call throws
    const out = await agentWith(genter).start({ task: "recent commits", mode: "recipes" });
    assert.equal(out.status, "done");
    assert.deepEqual(out.results.map((r) => r.id), ["rcp_1"]);
  });

  it("M9 a named anchor that failed in this round is not run again", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [COMMITS], results: {} });
    model = fakeModel([call("execute", { id: "rcp_commits" }), answer("rcp_commits")]);
    const out = await agentWith(genter).start({ task: "recent commits", mode: "recipes" });
    assert.equal(genter.executed.length, 1);
    assert.deepEqual(out.results, []);
    assert.equal(out.answer, "Nothing was found: no call held anything for this.");
  });

  it("M8 a continued run hands over that round's results too", async () => {
    const genter = fakeGenter({ connected: ["github", "gmail"], results });
    model = fakeModel([call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } }), answer("rcp_1"), call("execute", { tool: "GMAIL_FETCH_EMAILS", args: {} }), answer("rcp_2")]);
    const agent = agentWith(genter);
    const first = await agent.start({ task: "recent commits", mode: "recipes" });
    const next = await agent.send({ run_id: first.run_id, message: "and my emails" });
    assert.deepEqual(next.results.map((r) => r.tool), ["GMAIL_FETCH_EMAILS"]);
  });
});

describe("MCP raw anchors text", () => {
  const result = (extra = {}) => ({ id: "rcp_1", tool: "GMAIL_FETCH_EMAILS", args: { query: "from:anna" }, data: { messages: [{ id: "m1" }] }, created: true, changed: false, ...extra });

  it("each result under a line naming its call, then the JSON line with the anchors in that order", () => {
    const text = recipesResultText({ run_id: "r1", status: "done", answer: "rcp_1", results: [result({ account: "work" }), result({ id: "rcp_2", tool: "GITHUB_LIST_COMMITS", args: {}, data: [], created: false, title: "Commits" })], credits: 2 });
    const parts = text.split("\n\n");
    assert.equal(parts[0], 'Anchor 1: rcp_1 · GMAIL_FETCH_EMAILS {"query":"from:anna"} (account work)\n{"messages":[{"id":"m1"}]}');
    assert.equal(parts[1], "Anchor 2: rcp_2 · GITHUB_LIST_COMMITS — Commits\n[]");
    const meta = JSON.parse(parts.at(-1));
    assert.deepEqual(meta, { run_id: "r1", status: "done", recipes: [{ id: "rcp_1", tool: "GMAIL_FETCH_EMAILS", created: true }, { id: "rcp_2", tool: "GITHUB_LIST_COMMITS" }], credits: 2 });
    assert.doesNotMatch(text, /^rcp_1$/m); // the model's ids are not repeated as an answer
  });

  it("the person's prompt and the projects' prompts go along as instructions, once each", () => {
    const text = recipesResultText({ status: "done", results: [result({ instructions: "Group by author." }), result({ id: "rcp_2", instructions: "Group by author." })] }, { instructions: "Answer in Russian." });
    assert.equal(JSON.parse(text.slice(text.lastIndexOf("\n") + 1)).instructions, "Answer in Russian.\n\nGroup by author.");
  });

  it("a run that stopped for a connection says so first and tells what to do next", () => {
    const text = recipesResultText({ run_id: "r1", status: "needs_connection", answer: "Connect gmail: https://c — then continue this run.", connect_url: "https://c", results: [] });
    assert.match(text, /^Connect gmail: https:\/\/c/);
    const meta = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
    assert.equal(meta.connect_url, "https://c");
    assert.match(meta.next, /GENTER_CONTINUE_TASK/);
  });

  it("references with write on: how to write there", () => {
    const refs = [{ n: 1, app: "gmail", kind: "email", title: "Contract draft", where: { message_id: "m1" }, write: [{ tool: "GMAIL_REPLY_TO_THREAD", needs: ["message_body"], args: {} }] }];
    const text = recipesResultText({ run_id: "r1", status: "done", results: [result()], references: refs }, { write: true });
    assert.match(text, /References:\n\[1\] gmail email Contract draft/);
    assert.match(text, /write GMAIL_REPLY_TO_THREAD\(message_body\)/);
    assert.match(JSON.parse(text.slice(text.lastIndexOf("\n") + 1)).next, /GENTER_WRITE/);
  });

  it("base64 file contents are decoded; binary ones and everything else stay as they came", () => {
    const file = { content: { path: "a.js", encoding: "base64", content: Buffer.from("x = 1").toString("base64") } };
    assert.deepEqual(readable(file), { content: { path: "a.js", encoding: "utf-8", content: "x = 1" } });
    const binary = { content: { path: "a.png", encoding: "base64", content: Buffer.from([0, 255, 1]).toString("base64") } };
    assert.equal(readable(binary), binary);
    const list = [{ a: 1 }];
    assert.equal(readable(list), list);
  });

  it("GENTER_FIND takes an optional goal, described as for skills only, with an example", () => {
    const tool = agentTools().GENTER_FIND;
    assert.equal(tool.input.safeParse({ question: "q" }).success, true);
    assert.equal(tool.input.safeParse({ question: "q", goal: "writing docs" }).success, true);
    assert.equal(tool.input.safeParse({ goal: "writing docs" }).success, false); // question stays required
    assert.match(tool.description, /Optional `goal`/);
    assert.match(tool.description, /Skills for the goal/);
    assert.match(agentInstructions, /Optional goal/);
  });

  it("the goal is asked for as the exact step, not the area, with a pointed example", () => {
    const tool = agentTools().GENTER_FIND;
    for (const text of [tool.description, agentInstructions, tool.input.shape.goal.description]) {
      assert.match(text, /exact step/);
      assert.match(text, /quickstart page of the Evallens docs/);
      assert.match(text, /not "documentation"/);
    }
    assert.doesNotMatch(tool.description, /goal: \\?"writing product documentation\\?"/);
  });

  it("goal, conversation_id and model are in the schema (a client only sends fields the schema lists) and all optional", () => {
    const { input } = agentTools().GENTER_FIND;
    const parsed = input.parse({ question: "q", goal: "g", conversation_id: "k3x9a2fq", model: "m" });
    assert.deepEqual([parsed.goal, parsed.conversation_id, parsed.model], ["g", "k3x9a2fq", "m"]);
    assert.equal(input.safeParse({ question: "q", conversation_id: "x".repeat(201) }).success, false);
    assert.match(agentTools().GENTER_FIND.description, /conversation_id/);
    assert.match(agentInstructions, /conversation_id/);
  });

  it("skills picked by the goal come in their own section after the data, listed apart from the anchors", () => {
    const skill = { id: "rcp_s1", tool: "SKILL_READ_CHUNK", args: { skill: "docs-writing", chunk: "SKILL.md#intro" }, title: "docs-writing: intro", score: 0.8, data: { text: "Write short." } };
    const text = recipesResultText({ status: "done", direct: true, results: [result()], skills: [skill] });
    const parts = text.split("\n\n");
    assert.match(parts[0], /^Anchor 1: rcp_1/);
    assert.match(parts[1], /^Skills for the goal \(guides on how to do it, not data/);
    assert.equal(parts[2], 'Skill 1: rcp_s1 · SKILL_READ_CHUNK {"skill":"docs-writing","chunk":"SKILL.md#intro"} — docs-writing: intro\n{"text":"Write short."}');
    const meta = JSON.parse(parts.at(-1));
    assert.deepEqual(meta.recipes, [{ id: "rcp_1", tool: "GMAIL_FETCH_EMAILS", created: true }]);
    assert.deepEqual(meta.skills, [{ id: "rcp_s1", tool: "SKILL_READ_CHUNK", score: 0.8 }]);
  });

  it("without skills the text is as before: no section, no skills in the JSON", () => {
    const text = recipesResultText({ status: "done", results: [result()], skills: [] });
    assert.doesNotMatch(text, /Skills for the goal/);
    assert.equal("skills" in JSON.parse(text.slice(text.lastIndexOf("\n") + 1)), false);
  });

  it("GENTER_FIND says it returns raw data to answer from", () => {
    assert.match(agentTools().GENTER_FIND.description, /raw data, not a written answer/);
  });
});

describe("MCP result text", () => {
  it("passes the agent's suggestions into the meta line", () => {
    const text = agentResultText({ run_id: "r1", status: "done", answer: "ok", suggestions: [{ label: "Genterai/genter-cli" }] });
    const meta = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
    assert.deepEqual(meta.suggestions, [{ label: "Genterai/genter-cli" }]);
    const none = agentResultText({ run_id: "r1", status: "done", answer: "ok" });
    assert.equal("suggestions" in JSON.parse(none.slice(none.lastIndexOf("\n") + 1)), false);
  });
});

describe("gpt-oss calls that come as text, and tools of apps that are not connected", () => {
  const events = { items: [{ summary: "Standup", start: { dateTime: "2026-10-05T10:00:00Z" } }] };

  it("H1 a call written as text (harmony) is made, never shown as the answer", async () => {
    const genter = fakeGenter({ connected: ["googlecalendar"], results: { GOOGLECALENDAR_EVENTS_LIST: events } });
    model = fakeModel([
      answer(
        'analysisWe need today\'s events. Use execute.assistantcommentary to=functions.execute json{"tool": "GOOGLECALENDAR_EVENTS_LIST", "args": { "timeMin": "2026-10-05T00:00:00Z", "timeMax": "2026-10-06T00:00:00Z" } }',
      ),
      answer("**Standup** at 10:00 [1]."),
    ]);
    const out = await agentWith(genter).start({ task: "What's on my calendar today", mode: "find" });
    assert.deepEqual(genter.executed.map((e) => [e.tool, e.args.timeMin]), [["GOOGLECALENDAR_EVENTS_LIST", "2026-10-05T00:00:00Z"]]);
    assert.equal(out.status, "done");
    assert.equal(out.answer, "**Standup** at 10:00 [1].");
    const second = model.requests[1].messages;
    assert.equal(second.find((m) => m.role === "assistant").tool_calls[0].function.name, "execute");
    assert.ok(!second.some((m) => /analysisWe|to=functions/.test(m.content ?? "")));
  });

  it("H2 the final channel of a harmony text is the answer; reasoning alone is sent back once, then the run fails", async () => {
    const genter = fakeGenter({ connected: ["googlecalendar"] });
    model = fakeModel([answer("analysisThe user asks. Nothing to call.assistantfinalNo events today.")]);
    assert.equal((await agentWith(genter).start({ task: "What's on my calendar today", mode: "find" })).answer, "No events today.");
    model.restore();
    model = fakeModel([answer("analysisWe need to think about the calendar."), answer("analysisStill thinking.")]);
    const out = await agentWith(genter).start({ task: "What's on my calendar today", mode: "find" });
    assert.equal(out.status, "failed");
    assert.doesNotMatch(out.answer, /analysis/);
    assert.match(lastOf(model.requests[1], "user"), /not a call and not an answer/);
  });

  it("H3 a slug called as a function is an execute of it", async () => {
    const genter = fakeGenter({ connected: ["googlecalendar"], results: { GOOGLECALENDAR_EVENTS_LIST: events } });
    model = fakeModel([call("GOOGLECALENDAR_EVENTS_LIST", { timeMin: "2026-10-05T00:00:00Z" }), answer("Standup [1].")]);
    const out = await agentWith(genter).start({ task: "What's on my calendar today", mode: "find" });
    assert.deepEqual(genter.executed.map((e) => [e.tool, e.args]), [["GOOGLECALENDAR_EVENTS_LIST", { timeMin: "2026-10-05T00:00:00Z" }]]);
    assert.equal(out.status, "done");
  });

  it("H4 a tool of an app that is not connected: the error names the connected apps and their tools", async () => {
    const genter = fakeGenter({ connected: ["googlecalendar"], results: { GOOGLECALENDAR_EVENTS_LIST: events } });
    const searched = [];
    genter.search = async (args) => (searched.push(args), args.tools ? [{ id: null, tool: "GOOGLECALENDAR_EVENTS_LIST", description: "List events", args: {} }] : []);
    model = fakeModel([
      call("execute", { tool: "CLARIFY_MCP_GET_CALENDAR_EVENTS", args: {} }),
      (body) => {
        const reply = JSON.parse(lastOf(body, "tool"));
        assert.match(reply.error, /clarify, which is not connected\. Connected apps: googlecalendar/);
        assert.equal(reply.use_one_of[0].tool, "GOOGLECALENDAR_EVENTS_LIST");
        return call("execute", { tool: "GOOGLECALENDAR_EVENTS_LIST", args: {} });
      },
      answer("Standup [1]."),
    ]);
    const out = await agentWith(genter).start({ task: "What's on my calendar today", mode: "find" });
    assert.equal(out.status, "done");
    assert.ok(searched.every((s) => s.connected === true), "every tool search of the agent is of connected apps");
  });
});

describe("An answer that falls into a loop is never shown", () => {
  const good = "- **Пишите правду из продукта** [1]\n- **Один тип страницы — одна цель**: каждый документ должен быть либо учебником, ";
  const looped = `${good}как-то${"-как".repeat(2000)}`;
  const skill = { id: "rcp_docs", tool: "GITHUB_GET_REPOSITORY_CONTENT", title: "Docs skill", summary: "How to write docs", status: "fresh", score: 0.8 };

  it("L1 a looped answer is written again once, sampled and told where it looped; the loop is not sent back", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [skill] });
    model = fakeModel([answer(looped), answer(`${good}справочником или объяснением.`)]);
    const out = await agentWith(genter).start({ task: "Как делать документацию, читаемую людьми?", mode: "find" });
    assert.equal(out.status, "done");
    assert.equal(out.answer, `${good}справочником или объяснением.`);
    const [first, again] = model.requests;
    assert.equal(first.temperature, 0);
    assert.equal(first.max_tokens, 16_384);
    assert.equal(again.temperature, 1);
    assert.equal(again.frequency_penalty, 0.3);
    assert.match(lastOf(again, "user"), /fell into a loop: it wrote "-как" again and again/);
    assert.ok(!again.messages.some((m) => m.role === "assistant" && /как-как/.test(m.content ?? "")));
  });

  it("L2 looping again, the answer is cut where the loop starts", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [skill] });
    model = fakeModel([answer(looped), answer(looped)]);
    const out = await agentWith(genter).start({ task: "Как делать документацию, читаемую людьми?", mode: "find" });
    assert.equal(out.status, "done");
    assert.equal(out.answer, "- **Пишите правду из продукта** [1]\n- **Один тип страницы — одна цель**: каждый документ должен быть либо учебником…");
    assert.equal(model.requests.length, 2);
  });

  it("L3 an answer that is all loop is no answer: the model is asked for one", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_LIST_COMMITS: [{ sha: "a" }] } });
    const all = "как-".repeat(500);
    model = fakeModel([call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } }), answer(all), answer(all), answer("One commit [1].")]);
    const out = await agentWith(genter).start({ task: "recent commits of o/r", mode: "find" });
    assert.equal(out.answer, "One commit [1].");
    assert.match(lastOf(model.requests[3], "user"), /You ended without an answer/);
  });
});

describe("readQuestion: the request that reads a reference in full", () => {
  it("names what it is and where: a link, else the ids; a skill's piece as Search asks it", () => {
    assert.equal(readQuestion({ app: "website", kind: "page", title: "Pricing", url: "https://evallens.io/pricing" }), 'Read the page "Pricing" in full: https://evallens.io/pricing');
    assert.equal(readQuestion({ app: "gmail", kind: "email", title: "Invoice", where: { thread_id: "t1" } }), 'Read the gmail email "Invoice" in full {"thread_id":"t1"}');
    assert.equal(readQuestion({ app: "skill", title: "docs-writing", where: { chunk: "SKILL.md#install" } }), "Read the docs-writing skill: SKILL.md#install");
    assert.equal(readQuestion(null), null);
  });
});

describe("Read-only MCP (below Enterprise): Genter finds, the client writes", () => {
  const SEND = { id: "rcp_send", tool: "GMAIL_SEND_EMAIL", args: { to: "anna@x.com", body: "hi" }, title: "Email to Anna", status: "fresh", score: 0.5 };
  const mail = { messages: [{ messageId: "1", threadId: "t1", subject: "Contract", snippet: "Please sign" }] };

  it("R1 without actions the MCP tools only read; with them RUN_TASK and WRITE come too", () => {
    assert.deepEqual(Object.keys(agentTools()).sort(), ["GENTER_CONTINUE_TASK", "GENTER_FIND"]);
    assert.equal(agentTools().GENTER_CONTINUE_TASK.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(agentTools({ actions: true })).sort(), ["GENTER_CONTINUE_TASK", "GENTER_FIND", "GENTER_RUN_TASK", "GENTER_WRITE"]);
    // Every tool and the instructions say Genter only finds: the client's own model writes and rewrites.
    assert.match(agentInstructions, /Genter finds; you think and write/);
    assert.doesNotMatch(agentInstructions, /GENTER_RUN_TASK|GENTER_WRITE/);
    assert.match(agentTools().GENTER_FIND.description, /never writes, rewrites, summarizes or translates/);
    assert.match(agentTools({ actions: true }).GENTER_RUN_TASK.description, /passed word for word/);
    assert.match(actionInstructions, /never ask Genter to write or rewrite it/);
  });

  it("R2 a task asked of a read-only agent runs as a find: a tool that sends does not run", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results: { GMAIL_FETCH_EMAILS: mail, GMAIL_SEND_EMAIL: { id: "m1" } } });
    model = fakeModel([call("execute", { tool: "GMAIL_SEND_EMAIL", args: { to: "anna@x.com", body: "hi" } }), answer("Not sent: this is read-only.")]);
    const out = await agentWith(genter, { readOnly: true }).start({ task: "email Anna: hi" });
    assert.match(briefingOf(model.requests[0]), /Mode: find/);
    assert.deepEqual(genter.executed, []);
    assert.match(lastOf(model.requests[1], "tool"), /Not allowed: GMAIL_SEND_EMAIL may change data/);
    assert.equal(out.status, "done");
  });

  it("R3 a read-only agent never writes: write() and a start with a target refuse", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_CREATE_AN_ISSUE_COMMENT: { id: 5 } } });
    const agent = agentWith(genter, { readOnly: true });
    await assert.rejects(agent.write({ ref: "https://github.com/a/b/issues/1", tool: "GITHUB_CREATE_AN_ISSUE_COMMENT", args: { body: "x" } }), /Read-only/);
    await assert.rejects(agent.start({ task: "x", target: { app: "github", kind: "issue", where: { owner: "a", repo: "b", issue_number: 1 } } }), /Read-only/);
    assert.deepEqual(genter.executed, []);
  });

  it("R4 a run started elsewhere (mode run) goes on read-only when continued by a read-only agent", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results: { GMAIL_FETCH_EMAILS: mail, GMAIL_SEND_EMAIL: { id: "m1" } } });
    const runs = memoryRuns();
    model = fakeModel([call("execute", { tool: "GMAIL_FETCH_EMAILS", args: {} }), answer("Anna asks to sign [1].")]);
    const first = await agentWith(genter, { runs }).start({ task: "Anna's last email" });
    model.restore();
    genter.executed.length = 0;
    model = fakeModel([call("execute", { tool: "GMAIL_SEND_EMAIL", args: { to: "anna@x.com", body: "ok" } }), answer("Not sent.")]);
    await agentWith(genter, { runs, readOnly: true }).send({ run_id: first.run_id, message: "now reply: ok" });
    assert.deepEqual(genter.executed, []);
  });

  it("R5 a read-only run looks up an anchor id it did not meet: a saved send does not run, a saved read does", async () => {
    const genter = fakeGenter({ connected: ["gmail"], results: { GMAIL_FETCH_EMAILS: mail, GMAIL_SEND_EMAIL: { id: "m1" } } });
    genter.recipes.get = async (id) => ({ rcp_send: SEND, rcp_read: { id: "rcp_read", tool: "GMAIL_FETCH_EMAILS" } })[id];
    model = fakeModel([call("execute", { id: "rcp_send" }), call("execute", { id: "rcp_unknown" }), answer("Nothing sent.")]);
    await agentWith(genter).start({ task: "Anna's emails", mode: "find" });
    assert.deepEqual(genter.executed, []);
    assert.match(lastOf(model.requests[1], "tool"), /Not allowed: GMAIL_SEND_EMAIL/);
    assert.match(lastOf(model.requests[2], "tool"), /Not allowed: anchor rcp_unknown/);
    model.restore();
    model = fakeModel([call("execute", { id: "rcp_read" }), answer("Anna asks to sign [1].")]);
    await agentWith(genter).start({ task: "Anna's emails", mode: "find" });
    assert.deepEqual(genter.executed.map((e) => e.id), ["rcp_read"]);
  });

  it("R6 a tool another mode offers is refused: recheck_recipe (a saved call run again) only answers an event", async () => {
    const genter = fakeGenter({ connected: ["gmail"] });
    model = fakeModel([call("recheck_recipe", { id: "rcp_send" }), call("execute", { tool: "forget_recipe", args: { id: "rcp_x" } }), answer("Nothing found.")]);
    await agentWith(genter).start({ task: "Anna's emails", mode: "find" });
    assert.deepEqual(genter.rechecked, []);
    assert.deepEqual(genter.gone, []);
    assert.match(lastOf(model.requests[1], "tool"), /Not allowed: recheck_recipe is not a tool of a find task/);
  });

  it("R7 a write with a change asks the agent to put its text there word for word", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_CREATE_AN_ISSUE_COMMENT: { id: 5 } } });
    model = fakeModel([answer("Done.")]);
    await agentWith(genter).write({ ref: "https://github.com/a/b/issues/1", change: "comment exactly: on it" }).catch(() => null);
    assert.match(lastOf(model.requests[0], "user"), /word for word: write no text of your own/);
  });
});
