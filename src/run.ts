import { parseArgs } from 'node:util';
import { type Change, InitError, isInside } from './change.js';
import { apply, displayPath, isPending, nextSteps, planChanges } from './init.js';
import { AGENT_IDS, AGENT_LABELS, type AgentId, displayRemote, type Machine, probe } from './probe.js';
import { DEFAULT_URL, IMPORT_PROMPT } from './text.js';

export interface Prompts {
  selectAgents(options: { value: AgentId; label: string; hint: string }[], initial: AgentId[]): Promise<AgentId[] | null>;
  confirm(message: string): Promise<boolean | null>;
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
  prompts: Prompts;
  version: string;
}

const HELP = `Usage: erkle init [options]

Connect your coding agents to Erkle, your team's shared memory.

Writes the erkle MCP server into each agent's config and adds an Erkle
instructions block to AGENTS.md / CLAUDE.md. Never signs in or talks to
Erkle; each agent runs its own browser sign-in.

Options:
  --agents <list>     claude,cursor,codex (default: ask, or the detected ones)
  --global            write user-level config instead of the repo's
  --url <url>         MCP server URL (default ${DEFAULT_URL}, or $ERKLE_URL)
  -y, --yes           apply without asking
  --dry-run           print the plan and write nothing
  --force             replace an existing erkle entry that has a different URL
  --no-instructions   don't touch AGENTS.md / CLAUDE.md
  -h, --help          show this help
  -v, --version       show the version
`;

class UsageError extends Error {}

const MARK: Record<Change['action'], string> = { create: '+', update: '~', unchanged: '=', conflict: '!' };

// Config files come from cloned repos; never let their bytes drive the terminal.
const printable = (t: string) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

export async function run(argv: string[], m: Machine, raw: Io): Promise<number> {
  const io: Io = { ...raw, out: (t) => raw.out(printable(t)), err: (t) => raw.err(printable(t)) };
  try {
    return await main(argv, m, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`erkle: ${err.message}\nRun \`erkle --help\` for usage.\n`);
      return 2;
    }
    if (err instanceof InitError) {
      io.err(`✖ ${err.message}\n`);
      return 1;
    }
    // A file we couldn't read while planning (a directory where a file should
    // be, a permission error). Planning writes nothing, so this is still exit 1.
    if (typeof (err as NodeJS.ErrnoException).code === 'string' && (err as NodeJS.ErrnoException).syscall) {
      io.err(`✖ ${(err as Error).message}. Nothing was changed.\n`);
      return 1;
    }
    throw err;
  }
}

async function main(argv: string[], m: Machine, io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agents: { type: 'string' },
        global: { type: 'boolean', default: false },
        url: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'no-instructions': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values: v, positionals } = parsed;

  if (v.version) {
    io.out(`${io.version}\n`);
    return 0;
  }
  if (v.help || positionals.length === 0) {
    io.out(HELP);
    return v.help ? 0 : 2;
  }
  if (positionals[0] !== 'init' || positionals.length > 1) {
    throw new UsageError(`unknown command: ${positionals.join(' ')}`);
  }

  const url = v.url ?? m.env.ERKLE_URL ?? DEFAULT_URL;
  if (!/^https?:\/\/[^/\s]+/.test(url)) throw new UsageError(`--url must be an http(s) URL, got ${url}`);

  let requested: AgentId[] | null = null;
  if (v.agents !== undefined) {
    const list = v.agents.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((a) => !(AGENT_IDS as readonly string[]).includes(a));
    if (bad.length || list.length === 0) {
      throw new UsageError(`--agents takes a list of ${AGENT_IDS.join(', ')}${bad.length ? `; unknown: ${bad.join(', ')}` : ''}`);
    }
    requested = AGENT_IDS.filter((a) => list.includes(a));
  }

  const p = probe(m);
  if (!p.repoRoot) io.out('▲ Not in a git repository.\n');
  else if (!p.origin) io.out('▲ No `origin` remote; agents need one to scope repo memories.\n');
  else io.out(`◆ Repository: ${displayRemote(p.origin)}   (from git remote origin)\n`);
  if (!p.repoRoot && !v.global) {
    throw new InitError('Project config is written to the repo root, so run this inside a repo, or pass --global.');
  }

  const detected = AGENT_IDS.filter((a) => p.detected[a]);
  let agents: AgentId[];
  if (requested) {
    agents = requested;
  } else if (io.interactive && !v.yes) {
    const picked = await io.prompts.selectAgents(
      AGENT_IDS.map((a) => ({ value: a, label: AGENT_LABELS[a], hint: p.detected[a] ?? 'not found' })),
      detected,
    );
    if (picked === null) return cancelled(io);
    agents = AGENT_IDS.filter((a) => picked.includes(a));
  } else {
    agents = detected;
    io.out(`◆ Agents: ${agents.length ? agents.map((a) => AGENT_LABELS[a]).join(', ') : 'none detected'}\n`);
  }
  if (agents.length === 0 && !(!v['no-instructions'] && p.repoRoot)) {
    throw new InitError('No agents selected. Pass --agents claude,cursor,codex.');
  }

  const changes = planChanges(m, {
    agents,
    global: v.global,
    url,
    force: v.force,
    instructions: !v['no-instructions'],
    repoRoot: p.repoRoot,
  });

  const show = (path: string) => displayPath(m, p.repoRoot, path);
  const width = Math.max(...changes.map((c) => show(c.path).length)) + 2;
  io.out('◆ Plan\n');
  for (const c of changes) io.out(`│ ${MARK[c.action]} ${show(c.path).padEnd(width)} ${c.summary}\n`);
  for (const c of changes) {
    if (c.kind === 'command' && isPending(c)) for (const cmd of c.commands) io.out(`│     $ ${cmd.join(' ')}\n`);
  }

  const pending = changes.filter(isPending);
  const conflicts = changes.filter((c) => c.action === 'conflict');
  if (v['dry-run']) {
    io.out(`◆ Dry run: ${pending.length ? `${pending.length} change(s) not written` : 'nothing to change'}.\n`);
    return 0;
  }
  if (pending.length === 0) {
    io.out(conflicts.length ? '◆ Nothing written. Resolve the conflicts above, or pass --force.\n' : '✔ Already set up. Nothing to change.\n');
    return 0;
  }
  if (!v.yes) {
    if (!io.interactive) throw new UsageError('not a terminal; pass --yes to apply, or --dry-run to preview');
    const ok = await io.prompts.confirm('Apply?');
    if (!ok) return cancelled(io);
  }

  apply(m, pending, show);
  io.out('✔ Done.\n');
  if (conflicts.length) io.out(`▲ Skipped ${conflicts.length} conflicting file(s). Re-run with --force to replace them.\n`);

  const steps = nextSteps(agents, v.global);
  if (steps.length) io.out(`\nNext:\n${steps.map((s) => `  ${s}\n`).join('')}`);
  const repoRoot = p.repoRoot;
  const commit = repoRoot ? pending.filter((c) => c.kind === 'file' && isInside(repoRoot, c.path)).map((c) => show(c.path)) : [];
  if (commit.length) io.out(`  Commit ${listJoin(commit)} so your team gets them.\n`);
  if (p.repoRoot) {
    io.out(`\nFirst run: paste this into your agent to import what the repo already knows:\n\n${indent(IMPORT_PROMPT)}\n`);
  }
  return 0;
}

// Declining is not an error: nothing was written and nothing failed.
function cancelled(io: Io): number {
  io.out('Cancelled. Nothing written.\n');
  return 0;
}

function listJoin(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function indent(text: string): string {
  return text.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
}
