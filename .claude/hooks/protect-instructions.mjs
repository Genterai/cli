// PreToolUse hook: CLAUDE.md and AGENTS.md are the people's instructions to agents, so no agent
// session edits, creates, moves or deletes them. Reading them stays allowed. Exit code 2 blocks the
// tool call and tells the agent why. Backed by the protect-instructions workflow on pull requests.
import { readFileSync } from 'node:fs';

const PROTECTED = /(^|[\\/\s'"`=])(CLAUDE|AGENTS)\.md\b/i;
// Shell commands that write, move or delete files (a mention of a protected file next to one blocks).
const WRITES = /(^|[^0-9&<>])>{1,2}(?!&)|\btee\b|\b(sed|perl|ruby)\b[^|;&]*\s-[a-z]*i|\b(mv|rm|cp|ln|truncate|patch|install|dd|chmod|touch|unlink)\b|\bgit\s+(rm|mv|checkout|restore|apply|am|cherry-pick|revert|reset|stash)\b|\b(writeFile|appendFile|write_text|rename|unlink)\w*\s*\(|open\([^)]*['"][wa+]/;

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
  process.stderr.write('Blocked: CLAUDE.md and AGENTS.md are protected. Agents never edit, create, move or delete them; a person changes them. Read them freely; if one should change, say what and why in your result instead.\n');
  process.exit(2);
}
process.exit(0);
