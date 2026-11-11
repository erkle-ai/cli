import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { type Change, type CommandChange, InitError, isInside, readIfExists, resolveTarget } from './change.js';
import { planCodex } from './codex.js';
import { planInstructions } from './instructions.js';
import { isObj, planJsonServer } from './json-config.js';
import { AGENT_LABELS, type AgentId, type Machine } from './probe.js';
import { SERVER_NAME } from './text.js';

export interface PlanOptions {
  agents: AgentId[];
  global: boolean;
  url: string;
  force: boolean;
  instructions: boolean;
  repoRoot: string | null;
}

export function displayPath(m: Machine, repoRoot: string | null, path: string): string {
  if (repoRoot && isInside(repoRoot, path)) return relative(repoRoot, path).split(sep).join('/');
  if (isInside(m.home, path)) return `~/${relative(m.home, path).split(sep).join('/')}`;
  return path;
}

export function planChanges(m: Machine, o: PlanOptions): Change[] {
  const project = !o.global;
  if (project && !o.repoRoot) throw new InitError('Project config needs a git repository; pass --global.');
  const base = project ? o.repoRoot! : m.home;
  const show = (p: string) => displayPath(m, o.repoRoot, p);
  const changes: Change[] = [];

  for (const agent of o.agents) {
    if (agent === 'claude') {
      if (project) {
        const p = join(base, '.mcp.json');
        changes.push(planJsonServer(p, readIfExists(p), { type: 'http', url: o.url }, o.force, show(p)));
      } else {
        changes.push(planClaudeUser(m, o.url, o.force));
      }
    } else if (agent === 'cursor') {
      const p = join(base, '.cursor', 'mcp.json');
      changes.push(planJsonServer(p, readIfExists(p), { url: o.url }, o.force, show(p)));
    } else {
      const codexDir = project ? join(base, '.codex') : (m.env.CODEX_HOME ?? join(m.home, '.codex'));
      const p = join(codexDir, 'config.toml');
      changes.push(planCodex(p, readIfExists(p), o.url, o.force, show(p)));
    }
  }

  if (o.instructions && o.repoRoot) changes.push(...planInstructions(o.repoRoot));

  // A cloned repo is untrusted: a committed symlink (AGENTS.md -> ~/.bashrc)
  // must not turn a project write into a write elsewhere on the machine.
  for (const c of changes) {
    if (c.kind === 'file' && (c.action === 'create' || c.action === 'update')) c.before = readIfExists(c.path);
  }

  const root = o.repoRoot ? realpathSync(o.repoRoot) : null;
  const targets = new Map<string, string>();
  for (const c of changes) {
    if (c.kind !== 'file' || !isPending(c)) continue;
    const target = resolveTarget(c.path);
    if (root && o.repoRoot && isInside(o.repoRoot, c.path) && !isInside(root, target)) {
      throw new InitError(`${show(c.path)} resolves to ${target}, outside the repository. Refusing to write there.`);
    }
    // Two configs linked to one file would each be planned from the same old
    // bytes, and the second write would silently undo the first.
    const other = targets.get(target);
    if (other) {
      throw new InitError(`${other} and ${show(c.path)} are the same file. Run init for one of those agents at a time.`);
    }
    targets.set(target, show(c.path));
  }
  return changes;
}

/**
 * Claude Code keeps user-scope servers in ~/.claude.json, a large file it
 * rewrites constantly, so go through its own CLI instead of editing it.
 */
function planClaudeUser(m: Machine, url: string, force: boolean): CommandChange {
  const path = join(m.env.CLAUDE_CONFIG_DIR ?? m.home, '.claude.json');
  const add = ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, url];
  const base = { kind: 'command' as const, path, rollback: [] as string[][] };
  let current: Record<string, unknown> | undefined;
  try {
    const root: unknown = JSON.parse(readIfExists(path) ?? '{}');
    const entry = isObj(root) && isObj(root.mcpServers) ? root.mcpServers[SERVER_NAME] : undefined;
    current = isObj(entry) ? entry : undefined;
  } catch {
    // Unreadable or not JSON: `claude mcp add` will report on its own file.
    current = undefined;
  }
  const currentUrl = current?.url;
  if (currentUrl === url) {
    return { ...base, action: 'unchanged', summary: `${SERVER_NAME} already set (user scope)`, commands: [] };
  }
  if (current !== undefined && !force) {
    return {
      ...base,
      action: 'conflict',
      summary: `${SERVER_NAME} points to ${String(currentUrl)}; pass --force to replace`,
      commands: [],
    };
  }
  if (!m.which('claude')) {
    throw new InitError('Claude Code with --global needs the `claude` CLI on PATH.');
  }
  return current === undefined
    ? { ...base, action: 'create', summary: `claude mcp add ${SERVER_NAME} (user scope)`, commands: [add] }
    : {
        ...base,
        action: 'update',
        summary: `replace ${SERVER_NAME} (user scope)`,
        commands: [['claude', 'mcp', 'remove', '--scope', 'user', SERVER_NAME], add],
        // If the add fails after the remove, put the old entry back.
        rollback: typeof currentUrl === 'string' ? [[...add.slice(0, -1), currentUrl]] : [],
      };
}

export const isPending = (c: Change) => c.action === 'create' || c.action === 'update';

/**
 * Apply pending changes. Every file is first written to a temp file beside its
 * target, so a permission or disk error stops the run before anything changes;
 * then the temp files are renamed into place, then CLI commands run.
 */
export function apply(m: Machine, changes: Change[], show: (path: string) => string): void {
  // The user may have edited a file while the Apply? prompt waited; writing
  // our plan now would silently undo that edit.
  for (const c of changes) {
    if (c.kind === 'file' && (c.action === 'create' || c.action === 'update') && c.before !== undefined) {
      if (readIfExists(c.path) !== c.before) {
        throw new InitError(`${show(c.path)} changed since the plan was made. Nothing was changed; run init again.`);
      }
    }
  }

  const staged: Staged[] = [];
  try {
    for (const c of changes) {
      if (c.kind === 'file' && (c.action === 'create' || c.action === 'update')) staged.push(stage(c.path, c.content));
    }
  } catch (err) {
    for (const s of staged) rmSync(s.tmp, { force: true });
    throw new InitError(`Couldn't write ${show(failedPath(err, changes))}: ${(err as Error).message}. Nothing was changed.`);
  }

  const done: string[] = [];
  for (const s of staged) {
    try {
      renameSync(s.tmp, s.target);
      done.push(show(s.path));
    } catch (err) {
      for (const rest of staged) rmSync(rest.tmp, { force: true });
      throw new InitError(`Couldn't write ${show(s.path)}: ${(err as Error).message}.${changedSoFar(done)}`);
    }
  }

  for (const c of changes) {
    if (c.kind !== 'command') continue;
    for (const [cmd, ...args] of c.commands) {
      const r = m.exec(cmd!, args, m.home);
      if (!r.ok) {
        for (const [rc, ...rargs] of c.rollback) m.exec(rc!, rargs, m.home);
        throw new InitError(`\`${[cmd, ...args].join(' ')}\` failed: ${(r.stderr || r.stdout).trim()}.${changedSoFar(done)}`);
      }
    }
  }
}

interface Staged {
  path: string;
  target: string;
  tmp: string;
}

/** Write `content` to a temp file next to where `path` really lives, keeping its mode. */
function stage(path: string, content: string): Staged {
  const target = resolveTarget(path);
  let mode: number | null = null;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw Object.assign(err as Error, { erklePath: path });
  }
  const tmp = join(dirname(target), `.${basename(target)}.erkle-${randomBytes(6).toString('hex')}.tmp`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, content);
      if (mode !== null) fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw Object.assign(err as Error, { erklePath: path });
  }
  return { path, target, tmp };
}

function failedPath(err: unknown, changes: Change[]): string {
  return (err as { erklePath?: string }).erklePath ?? changes[0]?.path ?? '';
}

function changedSoFar(done: string[]): string {
  return done.length ? ` Already written: ${done.join(', ')}. Re-running init is safe.` : ' Nothing was changed.';
}

export function nextSteps(agents: AgentId[], global: boolean): string[] {
  const lines: string[] = [];
  const pad = (s: string) => s.padEnd(12);
  for (const a of agents) {
    const label = pad(AGENT_LABELS[a]);
    if (a === 'claude') {
      lines.push(`${label} run /mcp, pick erkle, choose Authenticate`);
      if (!global) lines.push(`${pad('')} (it asks once to approve the project's .mcp.json servers)`);
    } else if (a === 'cursor') {
      lines.push(`${label} Settings → MCP → erkle → Connect`);
    } else {
      lines.push(`${label} run \`codex mcp login ${SERVER_NAME}\``);
      if (!global) lines.push(`${pad('')} (Codex loads .codex/config.toml only once you trust this project)`);
    }
  }
  return lines;
}
