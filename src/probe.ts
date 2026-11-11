import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type AgentId = 'claude' | 'cursor' | 'codex';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'cursor', 'codex'];

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
};

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Everything that touches the real machine, injected so tests stay in tmp. */
export interface Machine {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  which(cmd: string): boolean;
  exec(cmd: string, args: string[], cwd: string): ExecResult;
}

export interface Probe {
  repoRoot: string | null;
  origin: string | null;
  detected: Record<AgentId, string | null>;
}

export function probe(m: Machine): Probe {
  // Run from home with -C: on Windows a bare `git` is looked up in the cwd
  // first, and the cwd may be an untrusted clone.
  const top = m.exec('git', ['-C', m.cwd, 'rev-parse', '--show-toplevel'], m.home);
  // git prints C:/x on Windows; resolve() gives the native form path.join uses.
  const repoRoot = top.ok && top.stdout.trim() ? resolve(top.stdout.trim()) : null;
  let origin: string | null = null;
  if (repoRoot) {
    const r = m.exec('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], m.home);
    origin = r.ok ? r.stdout.trim() || null : null;
  }
  const dir = (name: string) => existsSync(join(m.home, name));
  const either = (cmd: string, home: string): string | null =>
    m.which(cmd) ? `found \`${cmd}\` on PATH` : dir(home) ? `found ~/${home}` : null;
  return {
    repoRoot,
    origin,
    detected: {
      claude: either('claude', '.claude'),
      cursor: dir('.cursor') ? 'found ~/.cursor' : null,
      codex: either('codex', '.codex'),
    },
  };
}

/**
 * Display form of a git remote: `git@github.com:acme/web.git` and
 * `https://github.com/acme/web` both become `github.com/acme/web`.
 */
export function displayRemote(remote: string): string {
  let s = remote.trim();
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^/@]*@/, '');
  return s.replace(/\.git$/, '').replace(/\/+$/, '');
}
