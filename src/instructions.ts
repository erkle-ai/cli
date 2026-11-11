import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { appendSeparator, type FileChange, InitError, lineEnding, readIfExists, withEol } from './change.js';
import { BLOCK_END, BLOCK_START, INSTRUCTIONS_BLOCK } from './text.js';

/**
 * Upsert the managed instructions block into the repo's agent instruction
 * files. Writes to AGENTS.md and CLAUDE.md when they exist; creates AGENTS.md
 * when neither does (Claude Code reads AGENTS.md when there's no CLAUDE.md).
 */
export function planInstructions(repoRoot: string): FileChange[] {
  const agents = join(repoRoot, 'AGENTS.md');
  const claude = join(repoRoot, 'CLAUDE.md');
  const agentsText = readIfExists(agents);
  const claudeText = readIfExists(claude);
  if (agentsText === null && claudeText !== null) return [upsertBlock(claude, claudeText, 'CLAUDE.md')];
  const changes = [upsertBlock(agents, agentsText, 'AGENTS.md')];
  const claudeIsAgents =
    claudeText !== null &&
    (realpathSync(claude) === realpathSync(agents) || /^@(\.\/)?AGENTS\.md\s*$/m.test(claudeText));
  if (claudeText !== null && !claudeIsAgents) changes.push(upsertBlock(claude, claudeText, 'CLAUDE.md'));
  return changes;
}

function upsertBlock(path: string, existing: string | null, display: string): FileChange {
  if (existing === null) {
    return { kind: 'file', path, action: 'create', summary: 'add Erkle instructions block', content: `${INSTRUCTIONS_BLOCK}\n` };
  }
  const eol = lineEnding(existing);
  const block = withEol(INSTRUCTIONS_BLOCK, eol);
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 && end === -1) {
    return {
      kind: 'file',
      path,
      action: 'update',
      summary: 'add Erkle instructions block',
      content: `${existing}${appendSeparator(existing, eol)}${block}${eol}`,
    };
  }
  if (start === -1 || end === -1 || end < start) {
    throw new InitError(`${display} has an unmatched ${start === -1 ? BLOCK_END : BLOCK_START} marker. Fix or remove it.`);
  }
  const content = existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  if (content === existing) {
    return { kind: 'file', path, action: 'unchanged', summary: 'Erkle instructions block up to date' };
  }
  return { kind: 'file', path, action: 'update', summary: 'update Erkle instructions block', content };
}
