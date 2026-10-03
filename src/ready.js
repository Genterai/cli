import { BUILTIN, pick } from "./sync.js";

// Ready recipes for popular apps: no model and no sample calls, the same recipes every time. They are made for a
// connected account as soon as it is connected, in seconds. A ready recipe has no parameters: it is one thing to get.
//   sync: one thing to keep as embeddings (a repository as a project, the mail of the last 90 days). Live sync or
//         Run now keeps all of it, search answers from it, triggers and a schedule keep it up to date.
//   read: one everyday read of the account's data, named by its result ("Open pull requests of Genterai/genter-cli",
//         "Unread emails in the inbox"). It runs once when it is made, so its result is known and searchable.
// An app with projects (GitHub) gets one call that lists them, and recipes per project with everything fixed in them.
// Dates in read args are placeholders filled when the call runs: {{today}}, {{tomorrow}}, {{now}}, {{ago.7d}}, {{ahead.7d}}.
//
// recipes({ run, account }) -> [{ key, kind: "sync" | "read", name, short, description, tags, estimate?, recipe | tool + args }]
//   key: stable within the app and account, so making them again updates the same recipes instead of adding more.
//   recipe (sync): a live sync recipe (sync.js), with the account it syncs on.

const FILE_EXCLUDE = BUILTIN.github.exclude;
const REPO_FIELDS = ["full_name", "description", "language", "topics", "visibility", "fork", "archived", "default_branch", "homepage", "html_url", "stargazers_count", "forks_count", "open_issues_count", "license.name", "created_at", "pushed_at"];
const ISSUE_FIELDS = ["title", "number", "state", "state_reason", "user.login", "assignees.login", "labels.name", "milestone.title", "comments", "created_at", "updated_at", "closed_at", "pull_request.merged_at", "html_url", "body"];

export const READY = {
  github: {
    name: "GitHub",
    async recipes({ run, account }) {
      const repos = [];
      for (let page = 1; page <= 10; page++) {
        const res = await run("GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", { per_page: 100, page, sort: "pushed", direction: "desc" }, account);
        if (res?.successful === false) throw new Error(`Could not list the repositories: ${errorText(res.error)}`);
        const found = [pick(res, ["data.repositories", "data.items", "data"])].flat().filter((r) => r?.full_name);
        repos.push(...found);
        if (found.length < 100) break;
      }
      const projects = repos.filter((r) => !r.archived && !r.disabled);
      // Reads of the most active projects; the rest are a click away through search.
      const active = projects.slice(0, 5);
      return [
        allRepos(repos.length, account),
        ...projects.map((r) => repoRecipe(r, account)),
        read("assigned", "Issues and pull requests assigned to me", "Open issues and pull requests assigned to the account, across its repositories, most recently updated first.", ["github", "issues", "assigned", "задачи", "назначено мне"], "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", { filter: "assigned", state: "open", sort: "updated", direction: "desc", per_page: 30 }),
        read("created", "Open issues and pull requests I created", "Open issues and pull requests the account created, across repositories, most recently updated first.", ["github", "issues", "pull requests", "мои"], "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", { filter: "created", state: "open", sort: "updated", direction: "desc", per_page: 30 }),
        read("recent", "Latest activity in my repositories", "Issues and pull requests updated most recently in every repository the account sees, open and closed.", ["github", "activity", "updates", "что нового", "активность"], "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", { filter: "all", state: "all", sort: "updated", direction: "desc", per_page: 30 }),
        ...active.flatMap((r) => [
          read(`commits:${r.id ?? r.full_name}`, `Recent commits of ${r.full_name}`, `The 20 latest commits on \`${r.default_branch}\` of ${r.full_name}: message, author and date.`, ["github", "commits", "коммиты", r.name], "GITHUB_LIST_COMMITS", { owner: r.owner?.login, repo: r.name, sha: r.default_branch, per_page: 20 }),
          read(`pulls:${r.id ?? r.full_name}`, `Open pull requests of ${r.full_name}`, `Pull requests open in ${r.full_name}: title, author, branches and description.`, ["github", "pull requests", "PR", "пулреквесты", r.name], "GITHUB_LIST_PULL_REQUESTS", { owner: r.owner?.login, repo: r.name, state: "open", per_page: 30 }),
        ]),
      ];
    },
  },

  gmail: {
    name: "Gmail",
    recipes: async ({ account }) => [
      one({
        key: "mail",
        name: "Email of the last 90 days",
        short: "Every email of the last 90 days: subject, people, date and text",
        about: "Every email received or sent in the last 90 days, with its subject, sender, recipients, date, labels and text. New mail is added as it arrives.",
        tags: ["gmail", "email", "inbox", "почта", "письма"],
        account,
        recipe: {
          toolkit: "gmail",
          list: {
            tool: "GMAIL_FETCH_EMAILS",
            args: { query: "newer_than:90d -in:chats {{since?after:}}{{since_unix}}", max_results: 100, verbose: true, include_payload: false, page_token: "{{page}}" },
            text: "@item",
            fields: ["subject", "sender", "to", "cc", "messageTimestamp", "labelIds", "messageText"],
          },
          triggers: [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", config: { interval: 5 }, label: "on new email" }],
          every: 360,
        },
      }),
      mail("unread", "Unread emails in the inbox", "Unread emails in the inbox, newest first.", "is:unread in:inbox", ["unread", "непрочитанные"]),
      mail("today", "Emails of the last 24 hours", "Every email received in the last 24 hours, newest first.", "newer_than:1d -in:chats -in:sent", ["today", "сегодня"]),
      mail("important", "Important unread emails", "Unread emails Gmail marks as important.", "is:important is:unread", ["important", "важные"]),
      mail("starred", "Starred emails", "Emails marked with a star.", "is:starred", ["starred", "помеченные"]),
      mail("sent", "Emails I sent this week", "Emails sent from the account in the last 7 days.", "in:sent newer_than:7d", ["sent", "отправленные"]),
      mail("attachments", "Emails with attachments this month", "Emails of the last 30 days that have attachments.", "has:attachment newer_than:30d", ["attachments", "вложения"]),
    ],
  },

  googlecalendar: {
    name: "Google Calendar",
    recipes: async ({ account }) => [
      one({
        key: "events",
        name: "Calendar events",
        short: "Events of the main calendar: the last 90 days and the next year",
        about: "Events of the main calendar from 90 days ago to a year ahead: title, time, place, organizer, attendees and description.",
        tags: ["googlecalendar", "calendar", "events", "meetings", "календарь", "встречи"],
        account,
        recipe: {
          toolkit: "googlecalendar",
          list: {
            tool: "GOOGLECALENDAR_EVENTS_LIST",
            args: { calendarId: "primary", singleEvents: true, orderBy: "startTime", timeMin: "{{ago.90d}}", timeMax: "{{ahead.365d}}", maxResults: 250, pageToken: "{{page}}" },
            text: "@item",
            fields: ["summary", "start.dateTime", "start.date", "end.dateTime", "end.date", "location", "organizer.email", "attendees.email", "status", "htmlLink", "description"],
          },
          triggers: [
            { slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER", config: { calendarId: "primary" }, label: "on new events" },
            { slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER", config: { calendarId: "primary" }, label: "on changed events" },
          ],
          every: 360,
        },
      }),
      read("today", "Today's events", "Events of the main calendar today: title, time, place and attendees.", ["googlecalendar", "today", "сегодня", "встречи"], "GOOGLECALENDAR_EVENTS_LIST", { ...CALENDAR, timeMin: "{{today}}", timeMax: "{{tomorrow}}" }),
      read("tomorrow", "Tomorrow's events", "Events of the main calendar tomorrow.", ["googlecalendar", "tomorrow", "завтра"], "GOOGLECALENDAR_EVENTS_LIST", { ...CALENDAR, timeMin: "{{tomorrow}}", timeMax: "{{ahead.2d}}" }),
      read("week", "Events of the next 7 days", "Events of the main calendar from now to a week ahead.", ["googlecalendar", "week", "upcoming", "неделя", "ближайшие"], "GOOGLECALENDAR_EVENTS_LIST", { ...CALENDAR, timeMin: "{{now}}", timeMax: "{{ahead.7d}}", maxResults: 50 }),
      read("past", "Events of the past 7 days", "Events of the main calendar in the last 7 days.", ["googlecalendar", "past", "прошедшие"], "GOOGLECALENDAR_EVENTS_LIST", { ...CALENDAR, timeMin: "{{ago.7d}}", timeMax: "{{now}}", maxResults: 50 }),
      read("calendars", "My calendars", "Every calendar of the account: name, color, access and time zone.", ["googlecalendar", "calendars", "календари"], "GOOGLECALENDAR_LIST_CALENDARS", {}),
    ],
  },

  googletasks: {
    name: "Google Tasks",
    recipes: async ({ account }) => [
      one({
        key: "tasks",
        name: "Tasks of every list",
        short: "Every task of every task list, done ones too",
        about: "Every task of every Google Tasks list, open and completed, with its notes and due date.",
        tags: ["googletasks", "tasks", "todo", "задачи"],
        account,
        recipe: {
          toolkit: "googletasks",
          list: {
            tool: "GOOGLETASKS_LIST_TASKS",
            args: { tasklist_id: "{{container}}", maxResults: 100, pageToken: "{{page}}", showCompleted: true, showHidden: true },
            each: { tool: "GOOGLETASKS_LIST_TASK_LISTS", args: { maxResults: 100 }, max: 50 },
            text: "@item",
          },
          triggers: [
            { slug: "GOOGLETASKS_NEW_TASK_CREATED_TRIGGER", config: {}, label: "on new tasks" },
            { slug: "GOOGLETASKS_TASK_UPDATED_TRIGGER", config: {}, label: "on changed tasks" },
          ],
          every: 360,
        },
      }),
      read("open", "Open tasks of my main list", "Tasks not done yet in the default task list, with notes and due dates.", ["googletasks", "open", "todo", "открытые задачи"], "GOOGLETASKS_LIST_TASKS", { tasklist_id: "@default", showCompleted: false, maxResults: 100 }),
      read("lists", "My task lists", "Every task list of the account.", ["googletasks", "lists", "списки задач"], "GOOGLETASKS_LIST_TASK_LISTS", { maxResults: 100 }),
    ],
  },

  notion: {
    name: "Notion",
    recipes: async ({ account }) => {
      const notion = BUILTIN.notion;
      return [
        one({
          key: "pages",
          name: "Notion pages",
          short: "Every page shared with Genter, with its text",
          about: "Every Notion page shared with Genter, with its whole text, kept up to date on every edit.",
          tags: ["notion", "pages", "docs", "страницы", "документы"],
          account,
          recipe: { toolkit: "notion", list: notion.list, read: notion.read, triggers: notion.triggers, every: 360 },
        }),
        read("recent", "Recently edited Notion pages", "The 20 Notion pages edited most recently: title, link and when.", ["notion", "recent", "pages", "недавние страницы"], "NOTION_SEARCH_NOTION_PAGE", { filter_property: "object", filter_value: "page", page_size: 20, direction: "descending", timestamp: "last_edited_time" }),
      ];
    },
  },
};

const CALENDAR = { calendarId: "primary", singleEvents: true, orderBy: "startTime", maxResults: 100 };

// A ready read: one fixed call named by its result.
function read(key, name, about, tags, tool, args) {
  return { key: `read:${key}`, kind: "read", name, short: name, description: `### ${name}\n\n${about}\n\n\`${tool}\``, tags: [...new Set(tags)].filter(Boolean), tool, args };
}

// A ready Gmail read: one search.
const mail = (key, name, about, query, tags) => read(key, name, about, ["gmail", "email", "почта", "письма", ...tags], "GMAIL_FETCH_EMAILS", { query, max_results: 20, verbose: true, include_payload: false });

export const readyFor = (toolkit) => READY[String(toolkit ?? "").toLowerCase()] ?? null;

// A recipe for one account of an app, from what it keeps.
function one({ key, name, short, about, tags, account, recipe }) {
  return {
    key,
    kind: "sync",
    name,
    short,
    description: `### ${name}\n\n${about}`,
    tags: [...tags, "sync", "синхронизация"],
    recipe: { name, description: short, title: name, scope: {}, ...recipe, ...(account && { account }) },
  };
}

// Every repository the account sees, with what each is: answers "which projects do I have", "where is X written in Go".
function allRepos(count, account) {
  return {
    key: "repositories",
    kind: "sync",
    name: "GitHub repositories",
    short: `All ${count} repositories: description, language, topics, activity`,
    description:
      "### GitHub repositories\n\nEvery repository of the account (its own, its organizations', shared with it): description, " +
      "language, topics, visibility, default branch, stars and when it was last pushed.",
    tags: ["github", "repositories", "projects", "репозитории", "проекты", "sync", "синхронизация"],
    estimate: { level: "light", text: `${count} repositories · ${Math.max(1, Math.ceil(count / 100))} call${count > 100 ? "s" : ""} to GitHub per sync` },
    recipe: {
      toolkit: "github",
      name: "GitHub repositories",
      description: "Every repository of the account",
      title: "GitHub repositories",
      scope: {},
      ...(account && { account }),
      list: {
        tool: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
        args: { per_page: 100, page: "{{page}}", sort: "pushed", direction: "desc" },
        nextPage: true,
        items: "data.repositories",
        id: "full_name",
        version: "@fields",
        title: "full_name",
        url: "html_url",
        text: "@item",
        fields: REPO_FIELDS,
      },
      triggers: [],
      every: 1440,
    },
  };
}

// One repository as a project: its description, every file on the default branch and every issue and pull request.
// Files come from the repository's archive on the first sync (one download), then only changed files are read.
function repoRecipe(r, account) {
  const full = r.full_name;
  const vars = { owner: r.owner?.login ?? full.split("/")[0], repo: r.name ?? full.split("/")[1], branch: r.default_branch || "main" };
  const where = { owner: "{{owner}}", repo: "{{repo}}" };
  const push = { slug: "GITHUB_BRANCH_CHANGED_TRIGGER", config: { ...where, branch: "{{branch}}", interval: 10 }, label: "within 10 minutes of a push" };
  // Webhooks need admin rights on the repository; without them a push is noticed by polling.
  const triggers =
    r.permissions?.admin === false
      ? [push]
      : [
          { slug: "GITHUB_COMMIT_EVENT", config: where, label: "on every push", fallback: push },
          { slug: "GITHUB_ISSUE_ADDED_EVENT", config: where, label: "on new issues" },
          { slug: "GITHUB_PULL_REQUEST_EVENT", config: where, label: "on pull requests" },
        ];
  const kb = Number(r.size) || 0;
  const facts = [r.private ? "private" : "public", r.language, kb && `${size(kb)}`, r.pushed_at && `pushed ${String(r.pushed_at).slice(0, 10)}`].filter(Boolean).join(" · ");
  return {
    key: `repo:${r.id ?? full}`,
    kind: "sync",
    name: full,
    short: `The whole project: files, issues and pull requests of ${full}`,
    description:
      `### ${full}\n\nThe whole project as searchable knowledge: every file on \`${vars.branch}\` (code and docs), every issue and ` +
      `pull request (open and closed) and what the repository is.${r.description ? `\n\n> ${r.description}` : ""}\n\n${facts}`,
    tags: ["github", "repository", "project", "репозиторий", "проект", vars.repo, vars.owner, r.language, "sync", "синхронизация"].filter(Boolean),
    estimate: {
      level: kb < 5_000 ? "light" : kb < 50_000 ? "medium" : "heavy",
      text: `${kb ? `${size(kb)} repository · ` : ""}first sync: one archive download, then only changed files`,
    },
    recipe: {
      toolkit: "github",
      name: full,
      description: `Files, issues and pull requests of ${full}`,
      title: full,
      scope: {},
      vars,
      ...(account && { account }),
      parts: [
        {
          key: "about",
          name: "About",
          list: { tool: "GITHUB_GET_A_REPOSITORY", args: where, single: true, title: "{{owner}}/{{repo}}", url: "html_url", fields: REPO_FIELDS },
        },
        {
          key: "files",
          name: "Files",
          list: {
            tool: "GITHUB_GET_A_TREE",
            args: { ...where, tree_sha: "{{branch}}", recursive: true },
            items: "data.tree",
            where: { type: "blob" },
            id: "path",
            version: "sha",
            title: "path",
            size: "size",
            url: "https://github.com/{{owner}}/{{repo}}/blob/{{branch}}/{{item.path}}",
          },
          read: { tool: "GITHUB_GET_REPOSITORY_CONTENT", args: { ...where, path: "{{item.path}}", ref: "{{branch}}" }, text: "data.content.content", encoding: "data.content.encoding" },
          bulk: { tool: "GITHUB_DOWNLOAD_A_REPOSITORY_ARCHIVE_TAR", args: { ...where, ref: "{{branch}}" }, url: "data.headers.location", strip: 1 },
          exclude: FILE_EXCLUDE,
          maxSize: 300_000,
        },
        {
          key: "issues",
          name: "Issues and pull requests",
          list: {
            tool: "GITHUB_LIST_REPOSITORY_ISSUES",
            args: { ...where, state: "all", sort: "updated", direction: "desc", per_page: 100, page: "{{page}}", since: "{{since}}" },
            nextPage: true,
            items: "data.issues",
            id: "number",
            version: "updated_at",
            title: "#{{item.number}} {{item.title}}",
            url: "html_url",
            text: "@item",
            fields: ISSUE_FIELDS,
          },
        },
      ],
      triggers,
      every: 1440,
    },
  };
}

const size = (kb) => (kb >= 1024 ? `${(kb / 1024).toFixed(kb >= 10_240 ? 0 : 1)} MB` : `${kb} KB`);
const errorText = (e) => (typeof e === "string" ? e : JSON.stringify(e ?? "failed")).slice(0, 300);
