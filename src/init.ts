import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { type Change, type CommandChange, InitError, isInside, readIfExists, resolveTarget } from './change.js';
import { planCodex } from './codex.js';
import { planInstructions } from './instructions.js';
import { authMatches, headerAuth, headersFor, isObj, planJsonServer } from './json-config.js';
import { AGENT_LABELS, type AgentId, type Machine } from './probe.js';
import { type AgentEntry, API_KEY_ENV, type AuthMode, CLAUDE_KEY_HEADER, CURSOR_KEY_HEADER, SERVER_NAME } from './text.js';

export interface PlanOptions {
  agents: AgentId[];
  global: boolean;
  url: string;
  /** Key mode is user scope only; the caller sets `global` for it. */
  auth: AuthMode;
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
        const entry = { type: 'http', url: o.url };
        changes.push(planJsonServer(p, readIfExists(p), { entry, auth: o.auth, keyHeader: CLAUDE_KEY_HEADER, force: o.force, display: show(p) }));
      } else {
        changes.push(planClaudeUser(m, o.url, o.auth, o.force));
      }
    } else if (agent === 'cursor') {
      const p = project ? join(base, '.cursor', 'mcp.json') : userConfigPath(m, 'cursor');
      const entry = { url: o.url };
      changes.push(planJsonServer(p, readIfExists(p), { entry, auth: o.auth, keyHeader: CURSOR_KEY_HEADER, force: o.force, display: show(p) }));
    } else {
      const p = project ? join(base, '.codex', 'config.toml') : userConfigPath(m, 'codex');
      changes.push(planCodex(p, readIfExists(p), { url: o.url, auth: o.auth, force: o.force, display: show(p) }));
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
      throw new InitError(`${show(c.path)} resolves to ${target}, outside the repository. Refusing to write there.`, 'file_unsafe');
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

/** Where each agent keeps its user-level MCP config. Claude Code's is edited only through its own CLI. */
export function userConfigPath(m: Machine, agent: AgentId): string {
  if (agent === 'claude') return join(m.env.CLAUDE_CONFIG_DIR ?? m.home, '.claude.json');
  if (agent === 'cursor') return join(m.home, '.cursor', 'mcp.json');
  return join(m.env.CODEX_HOME ?? join(m.home, '.codex'), 'config.toml');
}

function claudeUserEntry(m: Machine): Record<string, unknown> | undefined {
  try {
    const root: unknown = JSON.parse(readIfExists(userConfigPath(m, 'claude')) ?? '{}');
    const entry = isObj(root) && isObj(root.mcpServers) ? root.mcpServers[SERVER_NAME] : undefined;
    return isObj(entry) ? entry : undefined;
  } catch {
    // Unreadable or not JSON: `claude mcp add` will report on its own file.
    return undefined;
  }
}

/** The user-scope Claude Code erkle entry, or null when there is none. */
export function readClaudeUser(m: Machine): AgentEntry | null {
  const entry = claudeUserEntry(m);
  if (!entry) return null;
  return { url: typeof entry.url === 'string' ? entry.url : null, auth: headerAuth(entry.headers, CLAUDE_KEY_HEADER) };
}

/** `claude mcp add --header` arguments for each header, in order. */
function headerArgs(headers: unknown): string[] {
  return isObj(headers) ? Object.entries(headers).flatMap(([k, v]) => ['--header', `${k}: ${String(v)}`]) : [];
}

/**
 * Claude Code keeps user-scope servers in ~/.claude.json, a large file it
 * rewrites constantly, so go through its own CLI instead of editing it.
 * Commands run as argv arrays with no shell, so `${ERKLE_API_KEY}` reaches
 * Claude Code literally and it expands the variable itself.
 */
function planClaudeUser(m: Machine, url: string, auth: AuthMode, force: boolean): CommandChange {
  const path = userConfigPath(m, 'claude');
  const addFor = (u: string) => ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, u];
  const base = { kind: 'command' as const, path, rollback: [] as string[][] };
  const current = claudeUserEntry(m);
  const currentUrl = current?.url;
  const currentAuth = headerAuth(current?.headers, CLAUDE_KEY_HEADER);
  if (current !== undefined && currentUrl === url && authMatches(currentAuth, auth)) {
    return { ...base, action: 'unchanged', summary: `${SERVER_NAME} already set (user scope)`, commands: [] };
  }
  if (current !== undefined && currentUrl !== url && !force) {
    return {
      ...base,
      action: 'conflict',
      summary: `${SERVER_NAME} points to ${String(currentUrl)}; pass --force to replace`,
      commands: [],
    };
  }
  // Only key mode replaces a user's own header; OAuth mode carries it over.
  if (auth === 'key' && currentAuth === 'custom' && !force) {
    return {
      ...base,
      action: 'conflict',
      summary: `${SERVER_NAME} has its own Authorization header; pass --force to replace`,
      commands: [],
    };
  }
  if (!m.which('claude')) {
    throw new InitError('Claude Code at user scope (--global or --auth key) needs the `claude` CLI on PATH.');
  }
  // `claude mcp add` replaces the whole entry, so carry the user's other headers over.
  const add = [...addFor(url), ...headerArgs(headersFor(current?.headers, auth, CLAUDE_KEY_HEADER))];
  return current === undefined
    ? { ...base, action: 'create', summary: `claude mcp add ${SERVER_NAME} (user scope)`, commands: [add] }
    : {
        ...base,
        action: 'update',
        summary: `replace ${SERVER_NAME} (user scope)`,
        commands: [['claude', 'mcp', 'remove', '--scope', 'user', SERVER_NAME], add],
        // If the add fails after the remove, put the old entry back, headers too.
        rollback: typeof currentUrl === 'string' ? [[...addFor(currentUrl), ...headerArgs(current.headers)]] : [],
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
    throw new InitError(`Couldn't write ${show(failedPath(err, changes))}: ${(err as Error).message}. Nothing was changed.`, 'file_unsafe');
  }

  const done: string[] = [];
  for (const s of staged) {
    try {
      renameSync(s.tmp, s.target);
      done.push(show(s.path));
    } catch (err) {
      for (const rest of staged) rmSync(rest.tmp, { force: true });
      throw new InitError(`Couldn't write ${show(s.path)}: ${(err as Error).message}.${changedSoFar(done)}`, 'file_unsafe');
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

/** "a", "a and b", "a, b and c". */
export function listJoin(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function nextSteps(agents: AgentId[], global: boolean, auth: AuthMode = 'oauth'): string[] {
  const lines: string[] = [];
  const pad = (s: string) => s.padEnd(12);
  if (auth === 'key') {
    if (agents.length === 0) return lines;
    lines.push(`Set ${API_KEY_ENV} to an Erkle API key, or run \`erkle keys create --env-file ~/.erkle.env\` and source that file.`);
    const names = agents.map((a) => AGENT_LABELS[a]);
    lines.push(`Then restart ${listJoin(names)} so ${names.length > 1 ? 'they read' : 'it reads'} the key.`);
    return lines;
  }
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
