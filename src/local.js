import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { driftFacts, supersededOf } from "./drift.js";
import { bm25, prepare, terms, topTerms } from "./lexical.js";
import { classifyFailure, contentHash, recipeId } from "./recipe.js";
import { cipher } from "./seal.js";
import { splitMarkdown } from "./skills.js";
import { crawl, forgetPage, readPage, siteUrl } from "./web.js";

// Genter with no keys and no packages: folders, files, public websites and the person's notes, searched where they are.
// Each file or page is an Anchor: one read call with a fixed argument (FILE_READ {path}, WEBSITE_READ_PAGE {url}).
// A search reads the sources again, so what it returns is what they say now: a file that changed is read in its new
// form, one that is gone is no answer any more, and the result says what changed since the last look. Nothing is
// copied: the store holds which places there are, their digests, headings and dates (sealed), never their text.
// Words rank the sections (lexical.js); with an OpenRouter key, embeddings rank them too.

export const LIMITS = { files: 5000, fileBytes: 1_000_000, passageChars: 1400, perPlace: 2, webCandidates: 8, chunkChars: 1500, dims: 256 };
export const FILE_READ = "FILE_READ";
export const PAGE_READ = "WEBSITE_READ_PAGE";

export const genterHome = () => process.env.GENTER_HOME || join(homedir(), ".genter");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target", "__pycache__", "venv", "env", "site-packages", "bower_components", "tmp", "temp", "logs"]);
const TEXT_FILE = /\.(md|mdx|markdown|txt|text|rst|adoc|asciidoc|org|tex|json|jsonc|ya?ml|toml|ini|cfg|conf|properties|csv|tsv|xml|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|pyi|rb|go|rs|java|kt|kts|scala|swift|m|mm|c|h|cc|cpp|hpp|cs|fs|php|lua|pl|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|tf|hcl|vue|svelte|astro|ex|exs|erl|clj|dart|r|jl|nim|zig|el|css|scss|less|ipynb)$/i;
const BARE_FILE = /^(readme|license|licence|changelog|contributing|authors|notice|makefile|dockerfile|procfile|gemfile|rakefile|justfile|codeowners|todo)$/i;
// Never read: keys and credentials, lockfiles and built files (noise).
const SECRET_FILE = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|service[-_]?account.*\.json|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg))$/i;
const NOISE_FILE = /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|cargo\.lock|poetry\.lock|gemfile\.lock|go\.sum|.*\.min\.(js|css)|.*\.map)$/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY/;
const MARKDOWN = /\.(md|mdx|markdown)$/i;

const now = () => new Date().toISOString();
const sha = (text) => createHash("sha256").update(text).digest("hex");

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data, pretty = false) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0));
  renameSync(tmp, file);
}

// The secret that seals the local store: config.json's, made on the first run (the same one the app commands use).
export function localSecret(home = genterHome()) {
  const file = join(home, "config.json");
  const config = readJson(file, {});
  if (config.secret) return config.secret;
  const secret = randomBytes(32).toString("base64");
  writeJson(file, { ...config, secret }, true);
  return secret;
}

export function createLocal({ home = genterHome(), secret, userId = "default", openrouterApiKey, embed, cwd = process.cwd() } = {}) {
  secret ??= localSecret(home);
  const { seal, open } = cipher(`${secret}:${userId}:local`);
  const file = join(home, "local.json");
  const notesPath = join(home, "notes.md");
  embed ??= openrouterApiKey ? openrouterEmbedder(openrouterApiKey) : null;
  const texts = new Map(); // path -> { mtimeMs, size, text, digest }: files read by this process, never stored
  const prepared = new Map(); // anchor id + digest -> its sections, ready to rank
  let state;
  let loadedAt = 0;
  let dirty = false;

  // The store, read again when another process (the command while the MCP server runs) wrote it.
  function load() {
    let at = 0;
    try {
      at = statSync(file).mtimeMs;
    } catch {}
    if (state && at === loadedAt) return state;
    const raw = readJson(file, null);
    try {
      state = raw?.blob ? open(raw.blob) : null;
    } catch {
      throw new Error(`${file} was sealed with another secret: move it away to start over`);
    }
    state ??= { v: 1, sources: {}, anchors: {}, vectors: {} };
    loadedAt = at;
    return state;
  }
  function save() {
    if (!dirty) return;
    writeJson(file, { v: 1, blob: seal(state) });
    dirty = false;
    try {
      loadedAt = statSync(file).mtimeMs;
    } catch {}
  }
  const anchorId = (tool, args) => recipeId({ workspaceId: userId, scope: "", tool, args });
  const place = (a) => (a.args.url ? a.args.url : shown(a.args.path, cwd));

  // ---- sources ----

  function sourceFor(target) {
    if (/^https?:\/\//i.test(target)) {
      const url = siteUrl(target);
      return { id: `src_${sha(`website|${url}`).slice(0, 16)}`, kind: "website", url };
    }
    const path = resolve(cwd, expandHome(target));
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`No such file or folder: ${target}`);
    }
    const kind = st.isDirectory() ? "folder" : "file";
    return { id: `src_${sha(`${kind}|${path}`).slice(0, 16)}`, kind, path };
  }

  // The files of a file or folder source: [{ path }], and whether the listing is whole.
  function filesOf(source) {
    if (source.kind === "file" || source.kind === "notes") return { files: [source.path], complete: true };
    return listFolder(source.path);
  }

  // One read of a file as its Anchor: { record, text, event } with event created | changed | back | unchanged | gone | null.
  function readFile(path, sourceId) {
    const s = state;
    const id = anchorId(FILE_READ, { path });
    const prev = s.anchors[id];
    let st = null;
    try {
      st = statSync(path);
    } catch {}
    if (!st?.isFile()) {
      texts.delete(path);
      if (prev && prev.status !== "gone") {
        s.anchors[id] = { ...prev, status: "gone", checked_at: now() };
        dirty = true;
        return { record: s.anchors[id], event: "gone" };
      }
      return { record: prev, event: null };
    }
    let hit = texts.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const text = st.size <= LIMITS.fileBytes ? readText(path) : null;
      if (text == null) return { record: prev, event: null };
      hit = { mtimeMs: st.mtimeMs, size: st.size, text, digest: contentHash(text) };
      texts.set(path, hit);
    }
    const at = now();
    const about = describeFile(path, hit.text, st);
    if (!prev) {
      s.anchors[id] = { id, tool: FILE_READ, args: { path }, source: sourceId, ...about, digest: hit.digest, size: st.size, mtimeMs: st.mtimeMs, status: "fresh", created_at: at, updated_at: at, checked_at: at };
      dirty = true;
      return { record: s.anchors[id], text: hit.text, event: "created" };
    }
    if (prev.digest !== hit.digest) {
      s.anchors[id] = { ...prev, ...about, digest: hit.digest, size: st.size, mtimeMs: st.mtimeMs, status: "fresh", updated_at: at, checked_at: at };
      dirty = true;
      return { record: s.anchors[id], text: hit.text, event: "changed" };
    }
    if (prev.status !== "fresh" || prev.mtimeMs !== st.mtimeMs) {
      s.anchors[id] = { ...prev, status: "fresh", mtimeMs: st.mtimeMs, checked_at: at };
      dirty = true;
      return { record: s.anchors[id], text: hit.text, event: prev.status !== "fresh" ? "back" : "unchanged" };
    }
    return { record: prev, text: hit.text, event: "unchanged" };
  }

  // Title, headings, dates and the replaced mark of a file, from its own text: no model.
  function describeFile(path, text, st) {
    const title = /^#\s+(.+)$/m.exec(text)?.[1].replace(/[`*_]/g, "").trim() || basename(path);
    const items = MARKDOWN.test(path) ? [...new Set(splitMarkdown(path, text).map((p) => p.headings.join(" › ")))].slice(0, 40) : [];
    const superseded = replacedMark({ title, text: text.slice(0, 1500) }, (link) => (/^https?:/i.test(link) ? link : localLink(path, link)));
    return { title: title.slice(0, 120), items, source_at: new Date(st.mtimeMs).toISOString(), superseded: superseded ?? undefined };
  }

  // A page read as its Anchor, the same way: { record, text, event }.
  function notePage(url, data, sourceId, extra) {
    const s = state;
    const id = anchorId(PAGE_READ, { url });
    const prev = s.anchors[id];
    const digest = contentHash(data);
    const at = now();
    const about = {
      title: String(data.title || url).slice(0, 120),
      items: [...new Set(splitMarkdown(url, data.text).map((p) => p.headings.join(" › ")))].slice(0, 40),
      terms: topTerms(`${data.title}\n${data.text}`),
      ...(extra?.last_modified && { source_at: new Date(extra.last_modified).toISOString() }),
      superseded: (extra?.redirect ?? replacedMark({ title: data.title, text: data.text.slice(0, 1500) }, (link) => absoluteLink(url, link))) ?? undefined,
    };
    if (!prev) {
      s.anchors[id] = { id, tool: PAGE_READ, args: { url }, source: sourceId, ...about, digest, status: "fresh", created_at: at, updated_at: at, checked_at: at };
      dirty = true;
      return { record: s.anchors[id], text: data.text, event: "created" };
    }
    const event = prev.digest !== digest ? "changed" : prev.status !== "fresh" ? "back" : "unchanged";
    s.anchors[id] = { ...prev, ...about, digest, status: "fresh", checked_at: at, ...(event === "changed" && { updated_at: at }) };
    dirty = true;
    return { record: s.anchors[id], text: data.text, event };
  }

  // Reads a website's pages now (a crawl) and keeps each as an Anchor; a known page the crawl no longer finds is read
  // again so a removed one (404) becomes gone.
  async function readSite(source, depth) {
    const s = state;
    const crawled = await crawl({ url: source.url, depth });
    if (!crawled.successful) throw new Error(crawled.error);
    const stats = { created: 0, changed: 0, unchanged: 0, gone: 0 };
    const seen = new Set();
    for (const p of crawled.data.pages) {
      const { record, event } = notePage(p.url, { url: p.url, title: p.title, text: p.text }, source.id);
      seen.add(record.id);
      if (event === "back") stats.changed++;
      else stats[event]++;
    }
    if (crawled.data.complete) {
      for (const a of Object.values(s.anchors)) {
        if (a.source !== source.id || seen.has(a.id) || a.status !== "fresh") continue;
        forgetPage(a.args.url);
        const got = await readPage({ url: a.args.url });
        if (got.successful) notePage(a.args.url, got.data, source.id, got.source);
        else if (classifyFailure(got.error) === "gone") {
          s.anchors[a.id] = { ...a, status: "gone", checked_at: now() };
          stats.gone++;
          dirty = true;
        }
      }
    }
    return { ...stats, places: crawled.data.pages.length, complete: crawled.data.complete };
  }

  // Lists a file or folder source and reads every file in it: [{ record, text, event }].
  function readFiles(source) {
    const s = state;
    const { files, complete } = filesOf(source);
    const out = files.map((path) => readFile(path, source.id));
    const listed = new Set(files);
    // A file of this source that a whole listing no longer has is gone (deleted, or ignored now); after a cut-off
    // listing it is read on its own.
    for (const a of Object.values(s.anchors)) {
      if (a.source !== source.id || a.tool !== FILE_READ || a.status !== "fresh" || listed.has(a.args.path)) continue;
      if (complete) {
        texts.delete(a.args.path);
        s.anchors[a.id] = { ...a, status: "gone", checked_at: now() };
        dirty = true;
        out.push({ record: s.anchors[a.id], event: "gone" });
      } else out.push(readFile(a.args.path, source.id));
    }
    return { reads: out, complete };
  }

  function addSource(source) {
    const s = state;
    if (!s.sources[source.id]) {
      s.sources[source.id] = { ...source, added_at: now() };
      dirty = true;
      return true;
    }
    return false;
  }

  function ensureNotes() {
    const source = { id: `src_${sha(`notes|${notesPath}`).slice(0, 16)}`, kind: "notes", path: notesPath };
    if (!existsSync(notesPath)) {
      mkdirSync(home, { recursive: true });
      writeFileSync(notesPath, "# Notes\n\nKept by `genter remember`. Edit or delete anything here: Genter reads this file again on every search.\n");
    }
    addSource(source);
    return source;
  }

  // ---- ranking ----

  // The sections of one read: [{ record, path?, url?, headings, from, to, text, doc }], cut once per content.
  function sectionsOf(record, text) {
    const key = `${record.id}:${record.digest}`;
    const hit = prepared.get(key);
    if (hit) return hit;
    const where = record.args.path ?? record.args.url;
    const starts = lineStarts(text);
    const pieces = MARKDOWN.test(where) || record.tool === PAGE_READ ? splitMarkdown(where, text).map((p) => [p.start, p.end, p.headings[0] === "Introduction" && p.headings.length === 1 ? [] : p.headings]) : blocks(text).map(([a, b]) => [a, b, []]);
    const name = record.tool === PAGE_READ ? record.title : basename(where);
    const out = pieces
      .map(([start, end, headings]) => {
        const body = text.slice(start, end);
        if (!body.trim()) return null;
        const from = lineOf(starts, start);
        const to = lineOf(starts, Math.max(start, end - 1));
        return { record, headings, from, to, text: body, doc: prepare({ head: `${name} ${headings.join(" ")}`, body }) };
      })
      .filter(Boolean);
    prepared.set(key, out);
    if (prepared.size > 20000) prepared.delete(prepared.keys().next().value);
    return out;
  }

  // Vectors of sections and of the question, from the store or embedded now (only new or changed sections).
  async function vectorsOf(sections, question) {
    const s = state;
    s.vectors ??= {};
    const model = embed.model ?? "";
    const keyOf = (x) => sha(`${model}\n${x.headings.join(" › ")}\n${x.text}`).slice(0, 24);
    const keys = sections.map(keyOf);
    const missing = [...new Set(keys.filter((k) => !s.vectors[k]))];
    const byKey = new Map(sections.map((x, i) => [keys[i], x]));
    const inputs = missing.map((k) => embedText(byKey.get(k)));
    const [q, ...fresh] = await embed([question, ...inputs]);
    missing.forEach((k, i) => {
      s.vectors[k] = toB64(shrink(fresh[i], model));
    });
    if (missing.length) dirty = true;
    const used = new Set(keys);
    const all = Object.keys(s.vectors);
    if (all.length > used.size * 2 + 2000) {
      for (const k of all) if (!used.has(k)) delete s.vectors[k];
      dirty = true;
    }
    return { query: shrink(q, model), sections: keys.map((k) => fromB64(s.vectors[k])) };
  }

  // ---- the API ----

  const api = {
    home,
    notesPath,

    // A folder, a file or a public website to search from now on: every file or page is read now and kept as an Anchor.
    // { source, places, created, changed, unchanged, gone, complete }.
    async add(target, { depth } = {}) {
      if (!target || typeof target !== "string") throw new Error("Pass a folder, a file or a website address");
      load();
      const source = sourceFor(target.trim());
      const isNew = addSource(source);
      let stats;
      if (source.kind === "website") stats = await readSite(source, depth);
      else {
        const { reads, complete } = readFiles(source);
        stats = { places: reads.filter((r) => r.text != null).length, created: 0, changed: 0, unchanged: 0, gone: 0, complete };
        for (const r of reads) if (r.event) stats[r.event === "back" ? "changed" : r.event]++;
      }
      save();
      return { source: shownSource(state.sources[source.id], cwd), new: isNew, ...stats };
    },

    // The sources searched: [{ id, kind, place, places, gone, added_at }].
    sources() {
      const s = load();
      return Object.values(s.sources).map((src) => {
        const anchors = Object.values(s.anchors).filter((a) => a.source === src.id);
        return { ...shownSource(src, cwd), places: anchors.filter((a) => a.status === "fresh").length, gone: anchors.filter((a) => a.status === "gone").length };
      });
    },

    // Stops searching a source and drops its Anchors: by its id, its path or its address. { source, removed }.
    forget(target) {
      const s = load();
      let id = s.sources[target] ? target : null;
      if (!id) {
        const want = /^https?:\/\//i.test(target) ? siteUrl(target) : resolve(cwd, expandHome(target));
        id = Object.values(s.sources).find((src) => (src.url ?? src.path) === want)?.id;
      }
      if (!id) throw new Error(`Not a source: ${target} (genter sources lists them)`);
      if (s.sources[id].kind === "notes") throw new Error(`Notes are a file: edit or delete what you want in ${notesPath}`);
      const source = s.sources[id];
      delete s.sources[id];
      let removed = 0;
      for (const a of Object.values(s.anchors)) {
        if (a.source === id) {
          delete s.anchors[a.id];
          removed++;
        }
      }
      dirty = true;
      save();
      return { source: shownSource(source, cwd), removed };
    },

    // Keeps a note in the notes file (a heading with the time, then the text). Search finds it with its date.
    remember(text) {
      const note = String(text ?? "").trim();
      if (!note) throw new Error("Nothing to remember");
      load();
      ensureNotes();
      const at = now();
      appendFileSync(notesPath, `\n## ${at.slice(0, 16).replace("T", " ")} UTC\n\n${note}\n`);
      save();
      return { path: notesPath, at, text: note };
    },

    // The sections that answer a question, read from their sources now. With no source yet, the current folder is added
    // first (never the home folder or the root). { question, results, changes, searched, semantic, added?, ms }.
    async find(question, { limit = 5 } = {}) {
      const started = Date.now();
      const q = String(question ?? "").trim();
      if (!q) throw new Error("Ask a question");
      limit = Math.max(1, Math.min(20, Number(limit) || 5));
      let added;
      if (!Object.values(load().sources).some((src) => src.kind !== "notes")) {
        const here = resolve(cwd);
        if (here !== resolve(homedir()) && here !== resolve("/")) added = await api.add(here);
      }
      if (existsSync(notesPath)) ensureNotes();
      const reads = [];
      const seenPaths = new Set();
      const changes = [];
      for (const source of Object.values(state.sources)) {
        if (source.kind === "website") continue;
        const fresh = added && source.id === added.source.id; // just read whole: nothing "changed since" yet
        for (const r of readFiles(source).reads) {
          if (r.record && r.event && r.event !== "unchanged" && !fresh && !(source.kind === "notes" && r.event === "created")) changes.push({ place: place(r.record), event: r.event === "back" ? "changed" : r.event });
          if (r.text == null || seenPaths.has(r.record.args.path)) continue;
          seenPaths.add(r.record.args.path);
          reads.push(r);
        }
      }
      // Websites: the pages whose saved terms fit are read again now; the rest are not touched.
      const pages = Object.values(state.anchors).filter((a) => a.tool === PAGE_READ && a.status === "fresh" && state.sources[a.source]);
      if (pages.length) {
        const docs = pages.map((a) => ({ tf: new Map(a.terms ?? []), len: (a.terms ?? []).reduce((n, [, c]) => n + c, 0), pairs: new Set() }));
        const scores = bm25(q, docs);
        const picked = pages.map((a, i) => [a, scores[i]]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.webCandidates).map(([a]) => a);
        await pool(picked, 4, async (a) => {
          forgetPage(a.args.url); // read now, not from what a crawl or an earlier search read
          const got = await readPage({ url: a.args.url });
          if (got.successful) {
            const r = notePage(a.args.url, got.data, a.source, got.source);
            if (r.event !== "unchanged") changes.push({ place: place(r.record), event: r.event === "back" ? "changed" : r.event });
            reads.push(r);
          } else if (classifyFailure(got.error) === "gone") {
            state.anchors[a.id] = { ...a, status: "gone", checked_at: now() };
            dirty = true;
            changes.push({ place: place(a), event: "gone" });
          }
        });
      }
      // Sections are cut once per content; the record they point to is the one read now.
      const sections = reads.flatMap((r) => sectionsOf(r.record, r.text).map((x) => ({ ...x, record: r.record })));
      const lexical = bm25(q, sections.map((x) => x.doc));
      let scores = lexical;
      let semantic = false;
      if (embed && sections.length) {
        try {
          const v = await vectorsOf(sections, q);
          const cos = v.sections.map((e) => dot(v.query, e));
          scores = fuse(lexical, cos);
          semantic = true;
        } catch (e) {
          semantic = `off: ${e.message.slice(0, 120)}`;
        }
      }
      const order = sections.map((x, i) => [x, scores[i]]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]);
      const picked = [];
      const perPlace = new Map();
      for (const [x, score] of order) {
        const n = perPlace.get(x.record.id) ?? 0;
        if (n >= LIMITS.perPlace) continue;
        perPlace.set(x.record.id, n + 1);
        picked.push([x, score]);
        if (picked.length >= limit) break;
      }
      // A section of a source marked as replaced brings the best section of what replaces it, when Genter reads that.
      const byPath = new Map();
      for (const x of sections) {
        const k = x.record.args.path ?? x.record.args.url;
        if (!byPath.has(k)) byPath.set(k, []);
        byPath.get(k).push(x);
      }
      const results = [];
      const changedNow = new Map(changes.map((c) => [c.place, c.event]));
      const qTerms = new Set(terms(q));
      const scoreOf = new Map(sections.map((x, i) => [x, scores[i]]));
      // Each picked section in order; one whose place marks itself as replaced is followed by the place that replaces
      // it: its section among the picked ones (moved up), else its best section of all.
      const queue = [...picked];
      const placeOf = (x) => x.record.args.path ?? x.record.args.url;
      while (queue.length) {
        const [x, score] = queue.shift();
        results.push(result(x, score, results.length + 1, qTerms, changedNow));
        const by = x.record.superseded?.by;
        if (!by || placeOf(x) === by || results.some((r) => (r.path ?? r.url) === by && r.ref !== results.at(-1).ref)) continue;
        const at = queue.findIndex(([y]) => placeOf(y) === by);
        let next = at >= 0 ? queue.splice(at, 1)[0] : null;
        if (!next && byPath.get(by)) {
          const best = [...byPath.get(by)].sort((a, b) => (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0))[0];
          next = [best, scoreOf.get(best) ?? 0];
        }
        if (next) results.push({ ...result(next[0], next[1], results.length + 1, qTerms, changedNow), replaces: results.at(-1).ref });
      }
      for (const r of results) r.facts = [...r.facts, ...driftFacts(r.signals, results.map((o) => o.signals)).map((f) => f.replace(/marked as replaced: (\S+)/, (_, p) => `marked as replaced: ${shown(p, cwd)}`))];
      for (const r of results) delete r.signals;
      save();
      return {
        question: q,
        results,
        changes,
        searched: { sources: Object.keys(state.sources).length, places: reads.length, sections: sections.length },
        semantic,
        ...(added && { added }),
        ms: Date.now() - started,
      };
    },
  };

  function result(x, score, ref, qTerms, changedNow) {
    const a = x.record;
    const passage = passageOf(x, qTerms);
    const event = changedNow.get(place(a));
    const facts = [];
    if (event === "changed") facts.push("changed since the last look");
    if (event === "created") facts.push("new since the last look");
    if (a.args.path === notesPath && /^\d{4}-\d{2}-\d{2}/.test(x.headings.at(-1) ?? "")) facts.push(`noted ${x.headings.at(-1)}`);
    return {
      ref,
      place: a.args.url ? a.args.url : `${shown(a.args.path, cwd)}:${passage.from}-${passage.to}`,
      ...(a.args.path && { path: a.args.path, lines: [passage.from, passage.to] }),
      ...(a.args.url && { url: a.args.url }),
      title: a.title,
      headings: x.headings,
      text: passage.text,
      score: Number(score.toFixed(3)),
      anchor: { id: a.id, tool: a.tool, args: a.args, status: a.status, updated_at: a.updated_at, ...(a.source_at && { source_at: a.source_at }), ...(a.superseded && { superseded: a.superseded }) },
      facts,
      signals: { source_at: a.source_at, updated_at: a.updated_at, superseded: a.superseded },
    };
  }

  return api;
}

// The answer as text, for a terminal and for MCP: what changed since the last look, then each section under the line
// that says where it is.
export function findText(out) {
  const lines = [];
  const what = { changed: "changed", created: "is new", gone: "is gone" };
  if (out.changes?.length) lines.push(`Since the last look: ${out.changes.slice(0, 12).map((c) => `${c.place} ${what[c.event] ?? c.event}`).join("; ")}${out.changes.length > 12 ? `; ${out.changes.length - 12} more` : ""}.`, "");
  if (!out.results.length) {
    lines.push(`Nothing in ${out.searched.places} places matches "${out.question}". Add more with: genter add <folder|file|url>`);
    return lines.join("\n");
  }
  for (const r of out.results) {
    const where = [r.headings?.length ? r.headings.join(" › ") : r.title].filter(Boolean).join("");
    lines.push(`[${r.ref}] ${r.place}${where ? ` · ${where}` : ""}`);
    const facts = [...(r.replaces ? [`replaces [${r.replaces}]`] : []), ...r.facts];
    if (facts.length) lines.push(`    ${facts.join(" · ")}`);
    lines.push(r.text.trim(), "");
  }
  return lines.join("\n").trimEnd();
}

// ---- files ----

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

// A path for people: relative to the current folder when it is inside it, else from ~.
export function shown(path, cwd = process.cwd()) {
  if (!path) return path;
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  const home = homedir();
  return path.startsWith(home + sep) ? `~/${relative(home, path).split(sep).join("/")}` : path;
}
const shownSource = (src, cwd) => src && { id: src.id, kind: src.kind, place: src.url ?? shown(src.path, cwd), added_at: src.added_at };

// The readable files of a folder: text and code, not hidden, not ignored by its .gitignore, not keys or lockfiles.
export function listFolder(root) {
  const ignored = gitignore(root);
  const files = [];
  let complete = true;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= LIMITS.files) {
        complete = false;
        return;
      }
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !ignored(rel, true)) walk(full);
      } else if (e.isFile() && readable(e.name) && !ignored(rel, false)) files.push(full);
    }
  };
  walk(root);
  return { files, complete };
}

export const readable = (name) => (TEXT_FILE.test(name) || BARE_FILE.test(name)) && !SECRET_FILE.test(name) && !NOISE_FILE.test(name);

// The rules of a folder's own .gitignore as a test (rel path, is a folder) -> ignored. Negations are not followed.
function gitignore(root) {
  let lines = [];
  try {
    lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
  } catch {}
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((pattern) => {
      const dirOnly = pattern.endsWith("/");
      let p = pattern.replace(/\/+$/, "");
      const anchored = p.includes("/");
      p = p.replace(/^\//, "");
      const source = p
        .split("**/")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
        .join("(?:.*/)?");
      const re = new RegExp(`^${source}$`);
      return (rel, isDir) => (!dirOnly || isDir) && (anchored ? re.test(rel) : re.test(rel.split("/").pop()));
    });
  return (rel, isDir) => rules.some((r) => r(rel, isDir));
}

// A file's text, or null for a binary file or one holding a private key.
function readText(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  const text = buf.toString("utf8");
  return PRIVATE_KEY.test(text) ? null : text;
}

// A link at the top of a file to the file it points to, when that file is there.
function localLink(from, link) {
  const clean = decodeURIComponent(link.replace(/[#?].*$/, ""));
  if (!clean) return null;
  const target = resolve(dirname(from), clean);
  return existsSync(target) ? target : null;
}
function absoluteLink(from, link) {
  try {
    return new URL(link, from).toString();
  } catch {
    return null;
  }
}

// The replaced mark of a document's top (drift.js), with a relative link beside it resolved.
function replacedMark(doc, resolveLink) {
  const mark = supersededOf(doc);
  if (!mark || mark.by) return mark;
  const head = String(doc.text).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5).join("\n");
  const link = /\]\(\s*<?([^)\s>]+)>?\s*\)/.exec(head)?.[1];
  const by = link && resolveLink(link);
  return by ? { ...mark, by } : mark;
}

// ---- text ----

function lineStarts(text) {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// Text that is not Markdown, cut at blank lines into blocks of about LIMITS.chunkChars: [[start, end]].
function blocks(text) {
  const out = [];
  let start = 0;
  let last = 0;
  const re = /\n[ \t]*\n/g;
  let m = re.exec(text);
  while (m) {
    if (m.index - start > LIMITS.chunkChars && last > start) {
      out.push([start, last]);
      start = last;
    }
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (text.length - start > LIMITS.chunkChars * 1.5 && last > start) {
    out.push([start, last]);
    start = last;
  }
  out.push([start, text.length]);
  // A block still longer than three blocks (no blank lines): cut at line ends.
  return out.flatMap(([a, b]) => {
    if (b - a <= LIMITS.chunkChars * 3) return [[a, b]];
    const parts = [];
    let from = a;
    while (b - from > LIMITS.chunkChars) {
      const cut = text.lastIndexOf("\n", from + LIMITS.chunkChars);
      const to = cut > from ? cut + 1 : from + LIMITS.chunkChars;
      parts.push([from, to]);
      from = to;
    }
    parts.push([from, b]);
    return parts;
  });
}

// The part of a section to show: all of it when short, else the lines around the one holding most of the question's
// words, under the section's first line (its heading).
function passageOf(x, qTerms) {
  const body = x.text.replace(/\s+$/, "");
  if (body.length <= LIMITS.passageChars) return { text: body.replace(/^\n+/, ""), from: x.from, to: x.from + body.split("\n").length - 1 };
  const lines = body.split("\n");
  const weight = lines.map((l) => terms(l).filter((t) => qTerms.has(t)).length);
  let best = weight.indexOf(Math.max(...weight));
  if (best < 0) best = 0;
  let a = best;
  let b = best;
  let size = lines[best].length;
  for (;;) {
    const down = b + 1 < lines.length && size + lines[b + 1].length + 1 <= LIMITS.passageChars;
    if (down) size += lines[++b].length + 1;
    const up = a > 1 && size + lines[a - 1].length + 1 <= LIMITS.passageChars;
    if (up) size += lines[--a].length + 1;
    if (!down && !up) break;
  }
  const head = a > 1 ? `${lines[0]}\n…\n` : a === 1 ? `${lines[0]}\n` : "";
  return { text: head + lines.slice(a, b + 1).join("\n") + (b < lines.length - 1 ? "\n…" : ""), from: x.from + a, to: x.from + b };
}

// ---- vectors ----

// Where embeddings come from: any OpenAI-compatible /embeddings endpoint. The first three need their key in the
// environment; Ollama runs on this computer, so nothing leaves it.
export const PROVIDERS = {
  openai: { url: "https://api.openai.com/v1", env: "OPENAI_API_KEY", model: "text-embedding-3-small" },
  openrouter: { url: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY", model: "openai/text-embedding-3-small" },
  vercel: { url: "https://ai-gateway.vercel.sh/v1", env: "AI_GATEWAY_API_KEY", model: "openai/text-embedding-3-small" },
  ollama: { url: "http://localhost:11434/v1", env: null, model: "nomic-embed-text" },
};

// The provider to embed with: GENTER_EMBED_URL (any endpoint, GENTER_EMBED_KEY, GENTER_EMBED_MODEL), else the one named
// (`name` or GENTER_PROVIDER), else the first whose key is set (OpenAI, OpenRouter, Vercel AI Gateway), else Ollama.
// { name, url, key?, model }.
export function embeddingProvider({ env = process.env, config = {}, name } = {}) {
  const model = env.GENTER_EMBED_MODEL || undefined;
  if (env.GENTER_EMBED_URL) return { name: "custom", url: env.GENTER_EMBED_URL.replace(/\/+$/, ""), key: env.GENTER_EMBED_KEY || undefined, model: model ?? "text-embedding-3-small" };
  const of = (n) => {
    const p = PROVIDERS[n];
    const key = p.env ? env[p.env] || (n === "openrouter" ? config.openrouter_api_key : undefined) : undefined;
    return { name: n, url: p.url, ...(key && { key }), model: model ?? p.model };
  };
  const named = name || env.GENTER_PROVIDER;
  if (named) {
    if (!PROVIDERS[named]) throw new Error(`Unknown provider "${named}": ${Object.keys(PROVIDERS).join(", ")}, or GENTER_EMBED_URL for any other`);
    const p = of(named);
    if (PROVIDERS[named].env && !p.key) throw new Error(`${named} needs ${PROVIDERS[named].env}`);
    return p;
  }
  return ["openai", "openrouter", "vercel"].map(of).find((p) => p.key) ?? of("ollama");
}

// Embeds texts in batches with a provider; no package. The function carries its model (vectors of two models never mix).
export function embedderFor({ name = "custom", url, key, model }) {
  const embed = async (texts) => {
    const batches = [];
    for (let i = 0; i < texts.length; i += 128) batches.push(texts.slice(i, i + 128));
    const out = await pool(batches, 4, async (input) => {
      let res;
      try {
        res = await fetch(`${url}/embeddings`, {
          method: "POST",
          headers: { ...(key && { Authorization: `Bearer ${key}` }), "Content-Type": "application/json" },
          body: JSON.stringify({ model, input }),
          signal: AbortSignal.timeout(60000),
        });
      } catch (e) {
        if (name === "ollama") throw new Error(`No embeddings: set OPENAI_API_KEY, OPENROUTER_API_KEY or AI_GATEWAY_API_KEY, or run Ollama (ollama pull ${model}), or GENTER_EMBED_URL (${e.cause?.code ?? e.message})`);
        throw e;
      }
      if (!res.ok) throw new Error(`Embeddings (${name}) failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    });
    return out.flat();
  };
  return Object.assign(embed, { provider: name, model });
}

// OpenRouter's, the model the hosted engine ranks with.
export const openrouterEmbedder = (apiKey, model = process.env.EMBEDDING_MODEL || PROVIDERS.openrouter.model) => embedderFor({ name: "openrouter", url: PROVIDERS.openrouter.url, key: apiKey, model });

const embedText = (x) => `${x.headings.join(" › ")}\n${x.text.slice(0, 2000)}`;
// text-embedding-3 vectors keep their first 256 numbers (they are trained to be cut); other models keep all of theirs.
function shrink(v, model = "") {
  const s = /text-embedding-3/.test(model) ? Array.from(v).slice(0, LIMITS.dims) : Array.from(v);
  const n = Math.hypot(...s) || 1;
  return Float32Array.from(s, (x) => x / n);
}
const toB64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
function fromB64(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

// Two rankings as one: reciprocal rank fusion of the words' ranking (sections that share a word) and the vectors'
// (their 100 closest sections).
export function fuse(lexical, cosine, k = 60) {
  const out = lexical.map(() => 0);
  const rank = (scores, n) =>
    scores
      .map((s, i) => [s, i])
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .forEach(([, i], r) => {
        out[i] += 1 / (k + r + 1);
      });
  rank(lexical, Infinity);
  rank(cosine.map((c) => c + 1), 100);
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
