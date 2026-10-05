import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAgent } from "../src/agent.js";
import { cipher } from "../src/genter.js";
import { agentResultText, agentTools } from "../src/tools.js";
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
    assert.match(text, /edit  \{edits: \[\{find, replace\}\], message\}: one commit, only those pieces change\n    write GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS\(message, content\)/);
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

  it("A10 GENTER_WRITE is in the MCP tools only where writing is on", () => {
    assert.ok(!("GENTER_WRITE" in agentTools()));
    const tool = agentTools({ write: true }).GENTER_WRITE;
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

  it("R1 read_file reads a file by owner, repo and path in a find: its text, a file reference, nothing saved as a recipe", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits], results });
    model = fakeModel([
      call("read_file", { owner: "Genterai", repo: "genter-cli", path: "/src/agent.js", branch: "main" }),
      (body) => {
        const out = JSON.parse(lastOf(body, "tool"));
        assert.equal(out.ref, 2); // [1] is the commits recipe
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
    model = fakeModel([call("read_file", { owner: "Genterai", repo: "genter-cli", path: "a.js" }), answer("Only recipes [1].")]);
    await agentWith(genter, { canExecute: false }).start({ task: "read a.js", mode: "find" });
    assert.match(lastOf(model.requests[1], "tool"), /Not allowed/);
    assert.equal(genter.executed.length, 0);
  });
});

describe("A task of several parts on a recipe of one: the tools of the other parts are found", () => {
  const commits = { id: "rec_commits", tool: "GITHUB_LIST_COMMITS", args: { owner: "Genterai", repo: "genter-cli" }, description: "### Recent commits of Genterai/genter-cli", summary: "20 commits", status: "valid", score: 0.8 };
  const file = { content: { path: "src/agent.js", sha: "s1", content: Buffer.from("const a = 1;\n").toString("base64"), encoding: "base64" } };

  it("P1 search_tools asks for Composio tools even when a recipe fits well", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [commits] });
    const asked = [];
    genter.search = async (input) => (asked.push(input), [commits]);
    model = fakeModel([call("search_tools", { query: "GITHUB_GET_COMMIT" }), answer("Commits [1].")]);
    await agentWith(genter).start({ task: "recent commits and their files", mode: "find" });
    assert.equal(asked.at(-1).tools, true);
    assert.equal(asked[0].tools, undefined); // the briefing's search stays recipe-first
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

describe("Recipes in the agent", () => {
  const stepsOf = (out) => out.steps.map((s) => s.recipe);

  it("N2 every executed step says what happened to its recipe, and the result lists saved and recipes_used", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_LIST_COMMITS: [{ sha: "a" }] } });
    model = fakeModel([call("execute", { tool: "GITHUB_LIST_COMMITS", args: { owner: "o", repo: "r" } }), answer("One commit.")]);
    const out = await agentWith(genter).start({ task: "recent commits of o/r", mode: "find" });
    assert.deepEqual(stepsOf(out), [{ id: "rcp_1", created: true, changed: false }]);
    assert.equal(out.steps[0].saved, "rcp_1"); // the older field stays
    assert.deepEqual(out.saved, [{ id: "rcp_1", created: true, changed: false }]);
    assert.deepEqual(out.recipes_used, ["rcp_1"]);
  });

  it("N3 the prompt: a recipe says which call to make, the real tool is always executed, calls are saved automatically", async () => {
    const genter = fakeGenter({ connected: ["github"], recipes: [COMMITS] });
    model = fakeModel([answer("ok")]);
    await agentWith(genter).start({ task: "recent commits", mode: "find" });
    const system = model.requests[0].messages[0].content;
    assert.match(system, /ALWAYS execute the real tool/);
    assert.match(system, /NOT the current value/);
    assert.match(system, /saved as a recipe automatically/);
    assert.doesNotMatch(system, /add_source|build_live_sync|search_knowledge|live sync/);
    const names = model.requests[0].tools.map((t) => t.function.name);
    for (const gone of ["add_source", "build_live_sync", "sync_source", "search_knowledge", "save_recipes"]) assert.ok(!names.includes(gone), gone);
    assert.ok(names.includes("suggest_prepare"));
    assert.ok(!names.includes("execute_many") && !names.includes("recheck_recipe")); // modes only
    assert.match(briefingOf(model.requests[0]), /last_result/);
  });

  it("N4 suggest_prepare records a suggestion and has no side effects", async () => {
    const genter = fakeGenter({ connected: ["github"], results: { GITHUB_GET_A_TREE: { tree: [] } } });
    model = fakeModel([call("suggest_prepare", { label: "Entire repository o/r", why: "many files" }), answer("Done.")]);
    const out = await agentWith(genter).start({ task: "what is in o/r?", mode: "find" });
    assert.deepEqual(out.suggestions, [{ label: "Entire repository o/r" }]);
    assert.equal(genter.executed.length, 0);
  });

  it("N5 a prepare task fans out reads with execute_many (4 at a time, max 100) and finishes with counts; writes are skipped", async () => {
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
      call("execute_many", { calls }),
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
    assert.match(out.answer, /Prepared 100 reads: 100 new recipes, 0 updated, 0 unchanged, 0 failed/);
    assert.equal(out.saved.length, 100);
  });

  it("N6 execute_many is refused outside a prepare task", async () => {
    const genter = fakeGenter({ connected: ["github"] });
    model = fakeModel([call("execute_many", { calls: [{ tool: "GITHUB_LIST_COMMITS" }] }), answer("no")]);
    await agentWith(genter).start({ task: "x", mode: "run" });
    assert.equal(genter.executed.length, 0);
  });

  it("N7 an event task rechecks only the affected recipes and forgets what was deleted; it never writes", async () => {
    const genter = fakeGenter({ connected: ["github"] });
    model = fakeModel([
      call("recheck_recipe", { id: "rcp_a_changed" }),
      call("forget_recipe", { id: "rcp_b", reason: "file deleted" }),
      call("execute", { tool: "GITHUB_CREATE_AN_ISSUE", args: {} }),
      answer("rcp_a changed, rcp_b forgotten."),
    ]);
    const out = await agentWith(genter).start({ task: "Event github push in o/r. Affected recipes: rcp_a_changed, rcp_b", mode: "event" });
    assert.deepEqual(genter.rechecked, ["rcp_a_changed"]);
    assert.deepEqual(genter.gone, ["rcp_b"]);
    assert.equal(genter.executed.length, 0); // the write was refused
    assert.deepEqual(out.steps.find((s) => s.tool === "recheck_recipe").recipe, { id: "rcp_a_changed", created: false, changed: true });
    assert.deepEqual(model.requests[0].tools.map((t) => t.function.name).filter((n) => ["recheck_recipe", "forget_recipe"].includes(n)), ["recheck_recipe", "forget_recipe"]);
    assert.match(briefingOf(model.requests[0]), /Mode: event/);
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
