import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocal, findText } from "./local.js";

// `genter demo`: what Genter does, in a second and on nothing of the person's: a folder of two docs in a temp folder,
// a question, an edit nobody tells Genter about, the same question, a doc marked as replaced. Its own store, removed after.

const DEPLOY = "# Deploy\n\n## Staging\n\nStaging deploys every Tuesday from `main`. The pooler listens on port 6432.\n\n## Production\n\nProduction ships on Thursday after the change review.\n";
const RUNBOOK = "# Runbook\n\n## Restarting the probes\n\nRestart the probes with `beacon restart --all`, then watch the probe dashboard.\n";
const RUNBOOK_V2 = "# Runbook v2\n\n## Restarting the probes\n\nRestart the probes one region at a time with `beacon restart --region eu`.\n";

export async function runDemo({ print = console.log } = {}) {
  const base = mkdtempSync(join(tmpdir(), "genter-demo-"));
  const dir = join(base, "acme");
  mkdirSync(join(dir, "docs"), { recursive: true });
  const write = (path, text) => writeFileSync(join(dir, path), text);
  const g = createLocal({ home: join(base, ".genter"), secret: "demo", cwd: dir });
  const indent = (text) => text.replace(/^/gm, "  ");
  const ask = async (question) => {
    print(`\n$ genter ask "${question}"`);
    const out = await g.find(question, { limit: 2 });
    print(indent(findText(out)));
    return out;
  };
  try {
    write("docs/deploy.md", DEPLOY);
    write("docs/runbook.md", RUNBOOK);
    print("Genter in a second: a folder of docs, a question, an edit nobody tells Genter about, the same question.");
    print("\n  acme/docs/deploy.md    Staging deploys every Tuesday from `main`. The pooler listens on port 6432.");
    print("  acme/docs/runbook.md   Restart the probes with `beacon restart --all`.");
    await g.add("docs");

    const first = await ask("which port does the staging pooler use?");
    const copy = first.results[0]?.text.split("\n").find((l) => /6432/.test(l));

    write("docs/deploy.md", DEPLOY.replace("Tuesday", "Wednesday").replace("6432", "5433"));
    print("\nSomeone edits docs/deploy.md: Wednesday, port 5433. Nobody tells Genter.");
    await ask("which port does the staging pooler use?");
    if (copy) print(`\n  A memory that kept a copy at the first question still answers:\n  "${copy.trim()}"`);

    write("docs/runbook-v2.md", RUNBOOK_V2);
    write("docs/runbook.md", `> **Deprecated:** replaced by [Runbook v2](runbook-v2.md)\n\n${RUNBOOK}`);
    print("\nSomeone writes docs/runbook-v2.md and marks the old runbook: \"> Deprecated: replaced by [Runbook v2](runbook-v2.md)\".");
    await ask("how do I restart the probes?");

    print(`
Nothing was installed, no key was used, no model was called, and nothing of yours was touched.

  Your folder:      npx genter-cli ask "how do we deploy?"
  Your agent:       claude mcp add genter -- npx -y genter-cli mcp
  Your apps:        genter login <token from https://genter.ai>`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
