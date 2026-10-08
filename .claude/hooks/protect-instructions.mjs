// PreToolUse hook: the agent policy of this repository is written by people only. The policy is CLAUDE.md, AGENTS.md,
// everything in .claude/ (settings, hooks, skills, routine rules) and the workflow that enforces it on pull requests.
// No agent session edits, creates, moves or deletes any of it; reading stays allowed. Exit code 2 blocks the tool call
// and tells the agent why. Backed by the protect-instructions workflow on pull requests.
import { readFileSync } from 'node:fs';

const PROTECTED = /(^|[\\/\s'"`=])((CLAUDE|AGENTS)\.md\b|\.claude([\\/\s'"`]|$)|\.github[\\/]workflows[\\/]protect-instructions\.yml\b)/i;
// Shell commands that write, move or delete files (a mention of a protected path next to one blocks).
const WRITES = /(^|[^0-9&<>])>{1,2}(?!&)|\btee\b|\b(sed|perl|ruby)\b[^|;&]*\s-[a-z]*i|\b(mv|rm|cp|ln|truncate|patch|install|dd|chmod|touch|unlink|mkdir)\b|\bgit\s+(rm|mv|checkout|restore|apply|am|cherry-pick|revert|reset|stash)\b|\b(writeFile|appendFile|write_text|rename|unlink|mkdir)\w*\s*\(|open\([^)]*['"][wa+]/;

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}
const tool = input.tool_name || '';
const args = input.tool_input || {};
let hit = false;
if (tool === 'Bash') {
  const cmd = String(args.command || '');
  hit = PROTECTED.test(cmd) && WRITES.test(cmd);
} else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  hit = PROTECTED.test(` ${args.file_path || args.notebook_path || ''}`);
}
if (hit) {
  process.stderr.write('Blocked: the agent policy (CLAUDE.md, AGENTS.md, everything in .claude/ and the protect-instructions workflow) is changed by people only. Read it freely; if it should change, say what and why in your result instead.\n');
  process.exit(2);
}
process.exit(0);
