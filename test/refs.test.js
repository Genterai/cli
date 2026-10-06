import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits, citedRefs, fileEditor, readCall, refFromUrl, refLabel, refsOfResult, shapeRef, writeHints } from "../src/refs.js";
import { readQuestion, readTarget, referenceText } from "../src/tools.js";
import { catalogues } from "./helpers.js";

// The references of one call's result, numbered like the agent numbers them.
function refsOf(app, tool, args, data) {
  const refs = [];
  const out = refsOfResult({ app, tool, args, data }, (r) => refs.push({ ...r, n: refs.length + 1 }) && refs.length);
  return { refs, ...out };
}
// The first item of an app's sample list (test/fixtures/catalogues.json) with the write hints from its catalogue.
function firstItem(app) {
  const { tool, args, data } = catalogues[app].list;
  const [ref] = refsOf(app, tool, args, data).refs;
  return { ref, hints: writeHints(ref, catalogues[app].tools) };
}
const tools = (hints) => hints.map((h) => h.tool);

describe("GitHub: a project synced as knowledge", () => {
  // A hit of the ready repository recipe (parts about/files/issues), as sources.search returns it.
  const hit = (over) =>
    shapeRef({
      app: "github",
      via: "knowledge",
      source: "src_1",
      tool: "GITHUB_GET_A_TREE",
      part: "files",
      item: "src/sync.js",
      title: "src/sync.js",
      url: "https://github.com/Genterai/genter-cli/blob/main/src/sync.js",
      where: { owner: "Genterai", repo: "genter-cli", branch: "main", tree_sha: "main", path: "src/sync.js", sha: "abc123" },
      ...over,
    });

  it("S1 a cited file: its path, link, where, and the commit tool with owner/repo/path/branch filled", () => {
    const ref = hit();
    assert.equal(ref.kind, "file");
    assert.equal(ref.path, "src/sync.js");
    assert.deepEqual(ref.where, { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" });
    assert.equal(refLabel(ref), "Genterai/genter-cli/src/sync.js");
    const [commit] = writeHints(ref);
    assert.equal(commit.tool, "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS");
    assert.deepEqual(commit.args, { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" });
    assert.deepEqual(commit.needs, ["message", "content"]);
    // Changing it takes only edits: it is read here and committed whole, with the sha it was read at.
    const editor = fileEditor(ref);
    assert.deepEqual(editor.read, { tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", ref: "main" } });
    const { tool, args } = editor.write({ text: "SGVsbG8=", sha: "s1", message: "m" });
    assert.equal(tool, "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS");
    assert.equal(Buffer.from(args.content, "base64").toString(), "SGVsbG8="); // a text that looks like base64 stays text
    assert.deepEqual({ ...args, content: undefined }, { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main", message: "m", sha: "s1", content: undefined });
    assert.equal(fileEditor(shapeRef({ app: "github", url: "https://github.com/a/b/issues/1" })), null);
  });

  it("S1 an item synced before items kept `where`: the path comes from the item id, owner/repo/branch from the recipe", () => {
    const ref = hit({ where: { owner: "Genterai", repo: "genter-cli", branch: "main", tree_sha: "main" } });
    assert.deepEqual(ref.where, { owner: "Genterai", repo: "genter-cli", path: "src/sync.js", branch: "main" });
  });

  it("S1 the built-in github template: the folder filter in scope never replaces the file's path", () => {
    const ref = hit({ part: null, item: "docs/setup.md", where: { owner: "Genterai", repo: "genter-cli", path: "docs/", branch: "main" }, url: undefined });
    assert.equal(ref.path, "docs/setup.md");
  });

  it("S2 issues and pull requests of the project: comment and update tools with the number", () => {
    const issue = hit({ part: "issues", item: "42", title: "#42 Paging stops early", url: "https://github.com/Genterai/genter-cli/issues/42", tool: "GITHUB_LIST_REPOSITORY_ISSUES", where: { owner: "Genterai", repo: "genter-cli", number: 42 } });
    assert.equal(issue.kind, "issue");
    assert.deepEqual(issue.where, { owner: "Genterai", repo: "genter-cli", issue_number: 42 });
    assert.equal(refLabel(issue), "Genterai/genter-cli #42 Paging stops early");
    assert.deepEqual(tools(writeHints(issue)), ["GITHUB_CREATE_AN_ISSUE_COMMENT", "GITHUB_UPDATE_AN_ISSUE"]);

    const pull = hit({ part: "issues", item: "43", title: "#43 Stop at a short page", url: "https://github.com/Genterai/genter-cli/pull/43", tool: "GITHUB_LIST_REPOSITORY_ISSUES", where: { owner: "Genterai", repo: "genter-cli" } });
    assert.equal(pull.kind, "pull_request");
    const hints = writeHints(pull);
    assert.deepEqual(tools(hints), ["GITHUB_CREATE_AN_ISSUE_COMMENT", "GITHUB_UPDATE_A_PULL_REQUEST"]);
    assert.deepEqual(hints[1].args, { owner: "Genterai", repo: "genter-cli", pull_number: 43 });
  });

  it("S2 the repository itself (its About part, or a list of repositories by full name)", () => {
    assert.deepEqual(hit({ part: "about", item: "all", tool: "GITHUB_GET_A_REPOSITORY", url: "https://github.com/Genterai/genter-cli" }).where, { owner: "Genterai", repo: "genter-cli" });
    const listed = shapeRef({ app: "github", via: "knowledge", tool: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", item: "Genterai/genter-backend", url: "https://github.com/Genterai/genter-backend" });
    assert.equal(listed.kind, "repository");
    assert.deepEqual(tools(writeHints(listed)), ["GITHUB_CREATE_AN_ISSUE", "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS"]);
  });
});

describe("GitHub: read live by a call", () => {
  it("S3 a file read with GITHUB_GET_REPOSITORY_CONTENT is one reference: path from the args, link from the result", () => {
    const { refs, ref } = refsOf("github", "GITHUB_GET_REPOSITORY_CONTENT", { owner: "Genterai", repo: "genter-cli", path: "README.md", ref: "main" }, {
      content: { name: "README.md", path: "README.md", sha: "f00", html_url: "https://github.com/Genterai/genter-cli/blob/main/README.md", content: "IyBnZW50ZXI=", encoding: "base64" },
    });
    assert.equal(ref, 1);
    assert.equal(refs[0].kind, "file");
    assert.equal(refs[0].via, "call");
    assert.deepEqual(refs[0].where, { owner: "Genterai", repo: "genter-cli", path: "README.md", branch: "main" });
    assert.equal(refs[0].url, "https://github.com/Genterai/genter-cli/blob/main/README.md");
  });

  it("S3 a list of pull requests: every item is citable (_ref) and points to its own number", () => {
    const { refs, data } = refsOf("github", "GITHUB_LIST_PULL_REQUESTS", { owner: "Genterai", repo: "genter-cli", state: "open", per_page: 30 }, {
      pull_requests: [
        { id: 1, number: 18, title: "Ready recipes", html_url: "https://github.com/Genterai/genter-cli/pull/18" },
        { id: 2, number: 19, title: "References", html_url: "https://github.com/Genterai/genter-cli/pull/19" },
      ],
    });
    assert.deepEqual(data.pull_requests.map((p) => p._ref), [1, 2]);
    assert.deepEqual(refs.map((r) => [r.kind, r.where.pull_number, r.title]), [["pull_request", 18, "Ready recipes"], ["pull_request", 19, "References"]]);
  });

  it("S4 links: a file, a folder, an issue, a pull request, a repository", () => {
    assert.deepEqual(refFromUrl("https://github.com/Genterai/genter-cli/blob/main/src/agent.js").where, { owner: "Genterai", repo: "genter-cli", path: "src/agent.js", branch: "main" });
    const folder = refFromUrl("https://github.com/Genterai/genter-cli/tree/main/docs");
    assert.equal(folder.kind, "folder");
    assert.deepEqual(writeHints(folder)[0].needs, ["path", "message", "content"]);
    assert.equal(refFromUrl("https://github.com/Genterai/genter-cli/issues/7").where.issue_number, 7);
    assert.equal(refFromUrl("https://github.com/Genterai/genter-cli/pull/8").kind, "pull_request");
    assert.equal(refFromUrl("https://github.com/Genterai/genter-cli").kind, "repository");
    assert.equal(refFromUrl("https://example.com/whatever"), null);
  });
});

describe("Popular apps that are not GitHub: known write tools", () => {
  it("S5 Notion: a database row is a page; content, properties and a comment, all with its page id", () => {
    const { ref, hints } = firstItem("notion");
    assert.equal(ref.kind, "page");
    assert.deepEqual(tools(hints), ["NOTION_ADD_MULTIPLE_PAGE_CONTENT", "NOTION_UPDATE_PAGE", "NOTION_CREATE_COMMENT"]);
    assert.deepEqual(hints[0].args, { parent_block_id: ref.where.page_id });
    assert.deepEqual(hints[2].args, { parent_page_id: ref.where.page_id });
    // The page id in a Notion link, with its dashes.
    assert.equal(refFromUrl("https://www.notion.so/acme/Roadmap-1c05287fa43f8012a3b4c5d6e7f80912").where.page_id, "1c05287f-a43f-8012-a3b4-c5d6e7f80912");
  });

  it("S6 Gmail: an email of a list result is answered in its thread, to its sender", () => {
    const { refs } = refsOf("gmail", "GMAIL_FETCH_EMAILS", { query: "is:unread", max_results: 20 }, {
      messages: [
        { messageId: "18c1", threadId: "18c0", subject: "Contract", sender: "Anna Petrova <anna@acme.com>", messageText: "Can we sign Thursday?" },
        { messageId: "18c2", threadId: "18b9", subject: "Invoice", sender: "billing@vendor.io", messageText: "Attached." },
      ],
    });
    const anna = refs[0];
    assert.equal(anna.kind, "email");
    assert.equal(anna.title, "Contract");
    assert.deepEqual(anna.where, { message_id: "18c1", thread_id: "18c0", from: "anna@acme.com" });
    const [reply, draft, label] = writeHints(anna);
    assert.deepEqual(reply, { tool: "GMAIL_REPLY_TO_THREAD", args: { thread_id: "18c0", recipient_email: "anna@acme.com" }, needs: ["message_body"], does: reply.does });
    assert.equal(draft.tool, "GMAIL_CREATE_EMAIL_DRAFT");
    assert.deepEqual(label.args, { message_id: "18c1" });
  });

  it("S7 Gmail synced as knowledge: the sender comes from the chunk, the message id from the item", () => {
    const ref = shapeRef({ app: "gmail", via: "knowledge", item: "18c1", title: "Contract", tool: "GMAIL_FETCH_EMAILS", where: { threadId: "18c0", messageId: "18c1" }, text: "subject: Contract\nsender: Anna <anna@acme.com>\n\nCan we sign Thursday?" });
    assert.deepEqual(ref.where, { message_id: "18c1", thread_id: "18c0", from: "anna@acme.com" });
  });

  it("S8 Google Calendar: the event's calendar and id go to PATCH_EVENT; an event link works too", () => {
    const { refs } = refsOf("googlecalendar", "GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", timeMin: "2026-10-03T00:00:00Z", singleEvents: true }, {
      items: [{ id: "evt1", summary: "Sync with Anna", htmlLink: "https://www.google.com/calendar/event?eid=ZXZ0MSBhbm5hQGFjbWUuY29t" }],
    });
    assert.deepEqual(writeHints(refs[0])[0].args, { calendar_id: "primary", event_id: "evt1" });
    const linked = refFromUrl("https://www.google.com/calendar/event?eid=ZXZ0MSBhbm5hQGFjbWUuY29t");
    assert.deepEqual(linked.where, { calendar_id: "anna@acme.com", event_id: "evt1" });
  });

  it("S9 Google Tasks synced per task list: the list is in the item id, the task patched or given a subtask", () => {
    const ref = shapeRef({ app: "googletasks", via: "knowledge", item: "list1/task9", title: "Inbox · Pay rent", tool: "GOOGLETASKS_LIST_TASKS", where: { tasklist_id: "list1", id: "task9" } });
    const [patch, sub] = writeHints(ref);
    assert.deepEqual(patch.args, { tasklist_id: "list1", task_id: "task9" });
    assert.deepEqual(sub.args, { tasklist_id: "list1", task_parent: "task9" });
  });
});

describe("Any other app: write tools found in its own catalogue", () => {
  it("S10 Linear: update the issue and comment on it by issueId; a filter of the list is never written back", () => {
    const { ref, hints } = firstItem("linear");
    assert.equal(ref.kind, "issue");
    assert.deepEqual(tools(hints).slice(0, 2), ["LINEAR_UPDATE_ISSUE", "LINEAR_CREATE_LINEAR_COMMENT"]);
    assert.deepEqual(hints[0].args, { issueId: ref.where.id }); // not assigneeId: "me" from the list's filter
    assert.deepEqual(hints[1].needs, ["body"]);
    assert.ok(!tools(hints).some((t) => /DELETE|ARCHIVE/.test(t)));
  });

  it("S11 Slack: the channel is only in the list's args; edit the message by ts or reply in its thread", () => {
    const { ref, hints } = firstItem("slack");
    assert.equal(ref.kind, "message");
    const byTool = Object.fromEntries(hints.map((h) => [h.tool, h.args]));
    assert.deepEqual(byTool.SLACK_UPDATES_A_SLACK_MESSAGE, { channel: "C07QX2M4B1F", ts: ref.where.ts });
    assert.deepEqual(byTool.SLACK_SEND_MESSAGE, { channel: "C07QX2M4B1F", thread_ts: ref.where.ts });
    assert.ok(!("SLACK_DELETES_A_MESSAGE_FROM_A_CHAT" in byTool));
  });

  it("S12 Jira: edit and comment with issue_id_or_key = the issue key", () => {
    const { ref, hints } = firstItem("jira");
    assert.equal(ref.where.key, "PLAT-231");
    assert.ok(tools(hints).includes("JIRA_EDIT_ISSUE") && tools(hints).includes("JIRA_ADD_COMMENT"));
    for (const h of hints) assert.equal(h.args.issue_id_or_key, "PLAT-231");
    assert.ok(!tools(hints).includes("JIRA_DELETE_ISSUE"));
  });

  it("S13 Trello: the card's id goes to idCard, never to idList", () => {
    const { ref, hints } = firstItem("trello");
    assert.equal(ref.kind, "card");
    assert.equal(hints[0].tool, "TRELLO_UPDATE_CARDS_BY_ID_CARD");
    assert.ok(tools(hints).includes("TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD"));
    for (const h of hints) {
      assert.equal(h.args.idCard, ref.where.id);
      assert.notEqual(h.args.idList, ref.where.id);
    }
  });

  it("S14 Airtable: base and table from the list call, the record from the item", () => {
    const { ref, hints } = firstItem("airtable");
    assert.equal(hints[0].tool, "AIRTABLE_UPDATE_RECORD");
    assert.deepEqual(hints[0].args, { baseId: "appQ7rT2xY9kLm3Np", recordId: ref.where.id, tableIdOrName: "tblR4sV8wZ1aBc5De" });
    assert.deepEqual(hints[0].needs, ["fields"]);
    assert.ok(tools(hints).includes("AIRTABLE_CREATE_COMMENT"));
    assert.ok(!tools(hints).some((t) => /DELETE|MULTIPLE/.test(t)));
  });

  it("S15 HubSpot: a deal is updated by dealId; removing it is never offered", () => {
    const { hints } = firstItem("hubspot");
    assert.deepEqual(tools(hints), ["HUBSPOT_UPDATE_DEAL"]);
    assert.deepEqual(hints[0].needs, ["properties"]);
  });

  it("S16 an item of another kind never fills an issue's id (a Linear project is not an issue)", () => {
    const project = shapeRef({ app: "linear", via: "item", tool: "LINEAR_LIST_LINEAR_PROJECTS", item: "p1", title: "Q4", where: { id: "p1" } });
    const hints = writeHints(project, catalogues.linear.tools);
    assert.deepEqual(tools(hints), ["LINEAR_UPDATE_LINEAR_PROJECT"]);
    assert.deepEqual(hints[0].args, { project_id: "p1" });
  });

  it("S17 no catalogue, or nothing that writes there: no hints, no error", () => {
    const ref = shapeRef({ app: "unknownapp", via: "item", tool: "UNKNOWNAPP_LIST_THINGS", item: "t1", where: { id: "t1" } });
    assert.deepEqual(writeHints(ref), []);
    assert.deepEqual(writeHints(ref, [{ slug: "UNKNOWNAPP_SEND_EMAIL", inputParameters: { properties: { to: {} }, required: ["to"] } }]), []);
    assert.deepEqual(writeHints(ref, catalogues.linear.tools), []); // another app's tools are never offered
  });
});

describe("Editing a file: only the pieces that change", () => {
  const file = "import a from \"a\";\n\nexport const limit = 10;\nexport const pages = 100;\n";
  it("E1 find/replace changes the one place it is at, append adds at the end, the rest stays byte for byte", () => {
    const out = applyEdits(file, [{ find: "export const limit = 10;", replace: "export const limit = 20;" }, { append: "export const max = 5;\n" }]);
    assert.equal(out, "import a from \"a\";\n\nexport const limit = 20;\nexport const pages = 100;\nexport const max = 5;\n");
    assert.equal(applyEdits("x", [{ append: "y" }]), "x\ny");
    assert.equal(applyEdits(file, [{ find: "\nexport const pages = 100;", replace: "" }]), "import a from \"a\";\n\nexport const limit = 10;\n");
  });
  it("E2 a CRLF file keeps its line endings", () => {
    assert.equal(applyEdits("a\r\nb\r\n", [{ find: "a\nb", replace: "x\ny" }, { append: "z\n" }]), "x\r\ny\r\nz\r\n");
  });
  it("E3 a find that is not there, or there twice, changes nothing and says why", () => {
    assert.throws(() => applyEdits(file, [{ find: "export const limit = 10; ", replace: "" }]), /edit 1: find is not in the file; lines like it: 3: "export const limit = 10;"/);
    assert.throws(() => applyEdits(file, [{ find: "export const", replace: "const" }]), /find is in the file 2 times/);
    assert.throws(() => applyEdits(file, [{ find: "", replace: "x" }]), /find is empty/);
    assert.throws(() => applyEdits(file, []), /edits is empty/);
    assert.throws(() => applyEdits("a\u0000b", [{ append: "c" }]), /binary/);
  });
});

describe("Which references an answer used", () => {
  const refs = [
    { n: 1, app: "github", kind: "file", title: "src/sync.js", path: "src/sync.js", url: "https://github.com/a/b/blob/main/src/sync.js", via: "knowledge", score: 0.5, round: 1 },
    { n: 2, app: "github", kind: "file", title: "src/agent.js", path: "src/agent.js", via: "knowledge", score: 0.7, round: 1 },
    { n: 3, app: "gmail", kind: "email", title: "Contract with Acme", via: "item", round: 1 },
    { n: 4, app: "github", kind: "issue", title: "#42", via: "call", round: 2 },
  ];
  it("S18 cited ones, in the order cited, also [1, 3]; unknown numbers and Markdown links are not citations", () => {
    assert.deepEqual(citedRefs("Paging stops [2]. Mail says Thursday [1, 3] [9]. See [1](https://x).", refs).map((r) => r.n), [2, 1, 3]);
  });
  it("S18 no marks: what the answer names, else this round's calls, else the closest knowledge", () => {
    assert.deepEqual(citedRefs("It is in src/agent.js.", refs, { round: 1 }).map((r) => r.n), [2]);
    assert.deepEqual(citedRefs("Done.", refs, { round: 2 }).map((r) => r.n), [4]);
    assert.deepEqual(citedRefs("Done.", refs, { round: 1 }).map((r) => r.n), [2, 1]);
  });
});

describe("Tool ranking", () => {
  it("T1 'the' and other empty words do not pull ..._FOR_THE_AUTHENTICATED_USER tools up", async () => {
    const { rankTools } = await import("../src/genter.js");
    const tools = ["GITHUB_LIST_GISTS_FOR_THE_AUTHENTICATED_USER", "GITHUB_GET_A_COMMIT", "GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER"].map((slug) => ({ slug, description: "" }));
    assert.equal(rankTools(tools, "show the commits of the repo", 1)[0].slug, "GITHUB_GET_A_COMMIT");
  });
});

describe("A skill's pieces as sources", () => {
  const skill = { id: "skl_1", name: "docsbook-static", version: "v1" };
  const chunk = (id, headings) => ({ skill, section: { id, path: "references/writing.md", title: headings.at(-1), headings }, text: "...", related: [{ path: "a.md", kind: "artifact" }, { path: "b.md", kind: "artifact" }], see_also: [] });
  it("each section is named by its own heading, the skill beside it, so two pieces of one skill are told apart; what it lists stays inside", () => {
    const refs = [];
    const add = (r) => (refs.push({ ...r, n: refs.length + 1 }), refs.length);
    for (const [id, headings] of [["w#pages", ["Writing pages"]], ["w#pages/7-style", ["Writing pages", "7. Style"]]]) {
      refsOfResult({ app: "skill", tool: "SKILL_READ_CHUNK", args: { skill: "skl_1", version: "v1", chunk: id }, data: chunk(id, headings) }, add);
    }
    assert.deepEqual(refs.map((r) => [r.kind, r.title, r.of, r.where.chunk]), [["section", "Writing pages", "docsbook-static", "w#pages"], ["section", "7. Style", "docsbook-static", "w#pages/7-style"]]);
    assert.equal(readQuestion(refs[1]), "Read the docsbook-static skill: w#pages/7-style");
    assert.match(referenceText(refs[1]), /^\[2\] skill section 7\. Style \(docsbook-static\)/);
  });
});

describe("reading one thing in full", () => {
  it("names a commit of a list by its message's first line", () => {
    const sha = "88bda019d0e859e0ec344fa92baea7b0f4f3adec";
    const { refs } = refsOf("github", "GITHUB_LIST_COMMITS", { owner: "Genterai", repo: "genter" }, {
      commits: [
        { sha, html_url: `https://github.com/Genterai/genter/commit/${sha}`, commit: { message: "Merge pull request #53\n\nPlan: Growth is sold" } },
        { sha: "c00109999b92326b05d22d8e37b6792afdd2c272", html_url: "https://github.com/Genterai/genter/commit/c00109999b92326b05d22d8e37b6792afdd2c272", commit: { message: "Plan: Growth is sold" } },
      ],
    });
    assert.equal(refs[0].title, "Merge pull request #53");
    assert.equal(refs[0].kind, "commit");
    assert.equal(refs[1].title, "Plan: Growth is sold");
  });

  it("reads back the reference a read request names, its ids from the link", () => {
    const sha = "88bda019d0e859e0ec344fa92baea7b0f4f3adec";
    const ref = { app: "github", kind: "commit", title: "Merge pull request #53", url: `https://github.com/Genterai/genter/commit/${sha}`, where: { owner: "Genterai", repo: "genter", commit_sha: sha } };
    const target = readTarget(readQuestion(ref));
    assert.deepEqual(target.where, { owner: "Genterai", repo: "genter", commit_sha: sha });
    assert.equal(target.title, "Merge pull request #53");
    assert.deepEqual(readCall(target), { tool: "GITHUB_GET_A_COMMIT", args: { owner: "Genterai", repo: "genter", ref: sha } });
    // Ids with no link.
    const mail = readTarget(readQuestion({ app: "gmail", kind: "email", title: 'Say "hi"', where: { message_id: "m1", thread_id: "t1" } }));
    assert.equal(mail.title, 'Say "hi"');
    assert.deepEqual(readCall(mail), { tool: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", args: { message_id: "m1" } });
    assert.equal(readTarget("Последний коммит Genter"), null);
    assert.equal(readTarget("Read the docs-writing skill: SKILL.md#install"), null);
  });

  it("has no read call for a calendar event, an issue with no number, or an unknown kind", () => {
    const eid = Buffer.from("abc123 genterhq@m").toString("base64");
    const event = readTarget(`Read the googlecalendar event "GEO vs SEO" in full: https://www.google.com/calendar/event?eid=${eid}`);
    assert.equal(event.where.event_id, "abc123");
    assert.equal(readCall(event), null);
    assert.equal(readCall({ app: "github", kind: "issue", where: { owner: "o", repo: "r" } }), null);
    assert.equal(readCall({ app: "notion", kind: "page", where: { page_id: "p" } }), null);
    assert.deepEqual(readCall(readTarget("Read the github pull_request \"#7\" in full: https://github.com/o/r/pull/7")), { tool: "GITHUB_GET_A_PULL_REQUEST", args: { owner: "o", repo: "r", pull_number: 7 } });
  });
});
