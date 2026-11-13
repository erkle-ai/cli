import { type Change, InitError, isInside } from '../change.js';
import { bearerOriginRefusal, DEFAULT_ORIGIN } from '../credentials.js';
import { apiOrigin, assertBearerAllowed, mcpUrl } from '../http.js';
import { apply, displayPath, isPending, listJoin, nextSteps, planChanges } from '../init.js';
import { UsageError } from '../output.js';
import { AGENT_IDS, AGENT_LABELS, type AgentId, displayRemote, probe } from '../probe.js';
import { API_KEY_ENV, AUTH_MODES, type AuthMode, IMPORT_PROMPT } from '../text.js';
import { COMMON_HELP, type Command, type Context, envHelp, jsonHelp, type Outcome, parseCommand, usageHint } from './command.js';

const HELP = `Usage: erkle init [options]

Connect your coding agents to Erkle, your team's shared memory.

Writes the erkle MCP server into each agent's config and adds an Erkle
instructions block to AGENTS.md / CLAUDE.md.
init itself never signs in or talks to Erkle. By default each agent runs
its own browser sign-in; with --auth key, each agent sends the API key in
$ERKLE_API_KEY instead, and the key itself is never written to a file.

Options:
  --agents <list>     claude,cursor,codex (default: ask, or the detected ones)
  --auth <mode>       oauth (default) or key; key writes user-level config only
  --global            write user-level config instead of the repo's
  -y, --yes           apply without asking
  --dry-run           print the plan and write nothing
  --force             replace an existing erkle entry with a different URL or,
                      with --auth key, its own Authorization header
  --no-instructions   don't touch AGENTS.md / CLAUDE.md
${COMMON_HELP}
Without a terminal, init never asks: pass --yes to apply, or --dry-run to preview.

${jsonHelp([
  ['repository', "this repo's origin remote, or null"],
  ['agents', 'the agents configured: "claude", "cursor", "codex"'],
  ['global, auth, url', 'the scope, auth mode, and MCP URL used'],
  ['dryRun, applied', 'whether this was a dry run, and whether anything was written'],
  ['changes', 'the plan: {path, action, summary, commands}, where action is "create", "update", "unchanged", or "conflict"'],
  ['nextSteps, commit', 'after applying: what to do next, and the repo files to commit'],
  ['apiKeyEnvSet', 'with --auth key, after applying: whether ERKLE_API_KEY is set in this shell'],
  ['cancelled', 'true when you declined at the prompt'],
])}
${envHelp([
  'ERKLE_URL',
  ['ERKLE_TOKEN_ORIGIN', 'with --auth key, a server other than https://erkle.ai that agents may send the key to when it comes from ERKLE_URL'],
  ['ERKLE_API_KEY', 'with --auth key, read by each agent when it connects; init only checks whether it is set'],
])}`;

const OPTIONS = {
  agents: { type: 'string' },
  auth: { type: 'string', default: 'oauth' },
  global: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  'dry-run': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'no-instructions': { type: 'boolean', default: false },
} as const;

const MARK: Record<Change['action'], string> = { create: '+', update: '~', unchanged: '=', conflict: '!' };

export const init: Command = {
  name: 'init',
  summary: 'connect Claude Code, Cursor and Codex to Erkle',
  help: HELP,
  run: runInit,
};

async function runInit(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('init', args, OPTIONS);
  if (positionals.length) throw new UsageError(`unknown command: init ${positionals.join(' ')}`, { hint: usageHint() });

  const url = mcpUrl(v.url, m.env);
  if (!(AUTH_MODES as readonly string[]).includes(v.auth)) {
    throw new UsageError(`--auth takes oauth or key, got ${v.auth}`, { hint: usageHint('init') });
  }
  const auth = v.auth as AuthMode;
  // A key header in a committed project file would switch every teammate off
  // their own sign-in, so key mode always writes user-level config.
  const global = v.global || auth === 'key';
  if (auth === 'key') {
    // The agents will send the key to this server on every call, so a URL
    // inherited from the environment (a repo's direnv, a CI config) must not
    // be able to pick it: only the default server, a --url typed for this
    // command, or the origin named in ERKLE_TOKEN_ORIGIN; over https, or http to this machine.
    const origin = apiOrigin(url);
    assertBearerAllowed(origin);
    if (bearerOriginRefusal(m, origin) === 'not_named' && v.url === undefined) {
      throw new UsageError(
        `--auth key would send your key to ${origin}, which came from ERKLE_URL.`,
        { hint: `Pass --url ${url} on the command line, or set ERKLE_TOKEN_ORIGIN=${origin}, if that server is yours.` },
      );
    }
    if (origin !== DEFAULT_ORIGIN) io.err(`▲ Agents will send ERKLE_API_KEY to ${origin}.\n`);
  } else if (v.force && v.url === undefined && apiOrigin(url) !== DEFAULT_ORIGIN) {
    // --force repoints an existing entry and keeps the user's own
    // Authorization header, so an inherited ERKLE_URL must not choose where
    // that header goes next.
    throw new UsageError(
      `--force would point existing agent config, and any Authorization header it carries, at ${apiOrigin(url)}, which came from ERKLE_URL.`,
      { hint: `Pass --url ${url} on the command line if that server is yours.` },
    );
  }

  let requested: AgentId[] | null = null;
  if (v.agents !== undefined) {
    const list = v.agents.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((a) => !(AGENT_IDS as readonly string[]).includes(a));
    if (bad.length || list.length === 0) {
      throw new UsageError(`--agents takes a list of ${AGENT_IDS.join(', ')}${bad.length ? `; unknown: ${bad.join(', ')}` : ''}`, {
        hint: usageHint('init'),
      });
    }
    requested = AGENT_IDS.filter((a) => list.includes(a));
  }

  const p = probe(m);
  if (!p.repoRoot) io.out('▲ Not in a git repository.\n');
  else if (!p.origin) io.out('▲ No `origin` remote; agents need one to scope repo memories.\n');
  else io.out(`◆ Repository: ${displayRemote(p.origin)}   (from git remote origin)\n`);
  if (!p.repoRoot && !global) {
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
    global,
    url,
    auth,
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
  const result = (applied: boolean, extra: Record<string, unknown> = {}): Outcome => ({
    data: {
      repository: p.origin ? displayRemote(p.origin) : null,
      agents,
      global,
      auth,
      url,
      dryRun: v['dry-run'],
      applied,
      changes: changes.map((c) => ({
        path: show(c.path),
        action: c.action,
        summary: c.summary,
        ...(c.kind === 'command' && isPending(c) ? { commands: c.commands } : {}),
      })),
      ...extra,
    },
  });

  if (v['dry-run']) {
    io.out(`◆ Dry run: ${pending.length ? `${pending.length} change(s) not written` : 'nothing to change'}.\n`);
    return result(false);
  }
  if (pending.length === 0) {
    io.out(conflicts.length ? '◆ Nothing written. Resolve the conflicts above, or pass --force.\n' : '✔ Already set up. Nothing to change.\n');
    return result(false);
  }
  if (!v.yes) {
    if (!io.interactive) throw new UsageError('not a terminal; pass --yes to apply, or --dry-run to preview', { hint: usageHint('init') });
    const ok = await io.prompts.confirm('Apply?');
    if (!ok) return cancelled(io);
  }

  apply(m, pending, show);
  io.out('✔ Done.\n');
  if (conflicts.length) io.out(`▲ Skipped ${conflicts.length} conflicting file(s). Re-run with --force to replace them.\n`);

  const steps = nextSteps(agents, global, auth);
  if (steps.length) io.out(`\nNext:\n${steps.map((s) => `  ${s}\n`).join('')}`);
  const keyEnv = auth === 'key' ? { apiKeyEnvSet: Boolean(m.env[API_KEY_ENV]) } : {};
  if (auth === 'key' && agents.length && !keyEnv.apiKeyEnvSet) io.out(`  ▲ ${API_KEY_ENV} is not set in this shell.\n`);
  const repoRoot = p.repoRoot;
  const commit = repoRoot ? pending.filter((c) => c.kind === 'file' && isInside(repoRoot, c.path)).map((c) => show(c.path)) : [];
  if (commit.length) io.out(`  Commit ${listJoin(commit)} so your team gets them.\n`);
  if (p.repoRoot) {
    io.out(`\nFirst run: paste this into your agent to import what the repo already knows:\n\n${indent(IMPORT_PROMPT)}\n`);
  }
  return result(true, { nextSteps: steps.map((s) => s.replace(/\s+/g, ' ').trim()), commit, ...keyEnv });
}

// Declining is not an error: nothing was written and nothing failed.
function cancelled(io: Context['io']): Outcome {
  io.out('Cancelled. Nothing written.\n');
  return { data: { cancelled: true, applied: false } };
}

function indent(text: string): string {
  return text.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
}
