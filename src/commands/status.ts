import { join } from 'node:path';
import { readIfExists } from '../change.js';
import { readCodex } from '../codex.js';
import { bearerOriginRefusal, DEFAULT_ORIGIN, resolveCredential } from '../credentials.js';
import { Api, apiOrigin, LOGIN_HINT, mcpUrl, serverReplyError, TEAM_HINT } from '../http.js';
import { displayPath, readClaudeUser, userConfigPath } from '../init.js';
import { readJsonServer } from '../json-config.js';
import { callTool, KeyRejectedError } from '../mcp-call.js';
import { CliError, type ErrorCode, UsageError } from '../output.js';
import { AGENT_IDS, AGENT_LABELS, type AgentId, displayRemote, type Machine, probe } from '../probe.js';
import { type AgentEntry, API_KEY_ENV, CLAUDE_KEY_HEADER, CURSOR_KEY_HEADER, type EntryAuth } from '../text.js';
import { COMMON_HELP, type Command, type Context, envHelp, jsonHelp, noPositionals, type Outcome, parseCommand, SESSION_ENV, usageHint } from './command.js';

const HELP = `Usage: erkle status

Show how each agent on this machine connects to Erkle, check the signed-in
session, and, when ${API_KEY_ENV} is set, check what that key can reach.

Exits 0 when every check that ran passed, 1 when any failed.

Options:
${COMMON_HELP}
${jsonHelp([
  ['server', 'the origin checked'],
  ['repository', "this repo's origin remote, or null"],
  ['agents', 'each agent: {agent, label, project, user}, where project (null outside a repo) and user are {path, url, auth} and auth is "oauth", "key", "custom", or "missing"'],
  ['checks', 'the checks that ran: {name ("session" or "key"), ok, message, and on failure code, reason, hint}. A passing key check adds team, access, and repository.'],
  ['skipped', 'the checks that did not run: {name, message, hint}'],
])}
When a check fails, the error document carries the same server, repository,
agents, checks, and skipped fields.

${envHelp([...SESSION_ENV, ['ERKLE_API_KEY', 'the API key to check; agents set up by `erkle init --auth key` send it']])}`;

type ConfigAuth = EntryAuth | 'missing';

interface ConfigReport {
  path: string;
  url: string | null;
  auth: ConfigAuth;
}

interface AgentReport {
  agent: AgentId;
  label: string;
  /** Null outside a git repository. */
  project: ConfigReport | null;
  user: ConfigReport;
}

type CheckName = 'session' | 'key';

interface Check {
  name: CheckName;
  ok: boolean;
  message: string;
  code?: ErrorCode;
  reason?: string;
  hint?: string;
  [detail: string]: unknown;
}

/** A check that did not run, and how to make it run. */
interface Skipped {
  name: CheckName;
  message: string;
  hint: string;
  code?: ErrorCode;
}

const KEYS_HINT = 'Run `erkle keys create` for a new key.';
const ENV_FILE_HINT =
  `Load the env file from your shell profile (for example add \`. ~/.erkle.env\` to ~/.zshrc or ~/.bashrc), ` +
  `or create one with \`erkle keys create --env-file ~/.erkle.env\`; then restart the agent.`;

const entryReport = (path: string, entry: AgentEntry | null): ConfigReport => ({
  path,
  url: entry?.url ?? null,
  auth: entry?.auth ?? 'missing',
});

/** Each agent's erkle entry at project scope (in a repo) and user scope, read the way init reads them. */
function readAgents(m: Machine, repoRoot: string | null): AgentReport[] {
  const show = (p: string) => displayPath(m, repoRoot, p);
  return AGENT_IDS.map((agent) => {
    let project: ConfigReport | null = null;
    let user: ConfigReport;
    if (agent === 'claude') {
      if (repoRoot) {
        const p = join(repoRoot, '.mcp.json');
        project = entryReport(show(p), readJsonServer(readIfExists(p), CLAUDE_KEY_HEADER));
      }
      user = entryReport(show(userConfigPath(m, 'claude')), readClaudeUser(m));
    } else if (agent === 'cursor') {
      if (repoRoot) {
        const p = join(repoRoot, '.cursor', 'mcp.json');
        project = entryReport(show(p), readJsonServer(readIfExists(p), CURSOR_KEY_HEADER));
      }
      const u = userConfigPath(m, 'cursor');
      user = entryReport(show(u), readJsonServer(readIfExists(u), CURSOR_KEY_HEADER));
    } else {
      if (repoRoot) {
        const p = join(repoRoot, '.codex', 'config.toml');
        project = entryReport(show(p), readCodex(readIfExists(p)));
      }
      const u = userConfigPath(m, 'codex');
      user = entryReport(show(u), readCodex(readIfExists(u)));
    }
    return { agent, label: AGENT_LABELS[agent], project, user };
  });
}

const failed = (name: CheckName, err: CliError | { code: ErrorCode; message: string; hint?: string | undefined; reason?: string | undefined }): Check => {
  const c: Check = { name, ok: false, code: err.code, message: err.message };
  if (err.reason !== undefined) c.reason = err.reason;
  if (err.hint) c.hint = err.hint;
  return c;
};

interface Me {
  user?: { email?: unknown; name?: unknown };
  activeTeam?: { id?: unknown; name?: unknown; slug?: unknown; role?: unknown } | null;
}

async function sessionCheck(m: Machine, version: string, origin: string): Promise<Check | Skipped> {
  let api: Api;
  try {
    const cred = resolveCredential(m, origin);
    if (!cred) return { name: 'session', message: `Not signed in to ${origin}.`, hint: LOGIN_HINT };
    api = new Api(m, version, origin, cred.token);
  } catch (err) {
    if (err instanceof UsageError) return { name: 'session', code: 'usage', message: err.message, hint: err.hint ?? usageHint('status') };
    if (err instanceof CliError) return failed('session', err);
    throw err;
  }
  try {
    const me = await api.get<Me>('/api/cli/me');
    if (typeof me?.user?.email !== 'string') {
      return failed('session', serverReplyError(origin, '/api/cli/me'));
    }
    const t = me.activeTeam;
    const activeTeam =
      t && typeof t.id === 'string' && typeof t.name === 'string'
        ? { id: t.id, name: t.name, slug: typeof t.slug === 'string' ? t.slug : null, role: typeof t.role === 'string' ? t.role : null }
        : null;
    const check: Check = {
      name: 'session',
      ok: true,
      message: `Signed in to ${origin} as ${me.user.email}${activeTeam ? `, team ${activeTeam.name}` : ', no active team'}.`,
      account: { email: me.user.email },
      activeTeam,
    };
    if (!activeTeam) check.hint = TEAM_HINT;
    return check;
  } catch (err) {
    if (err instanceof CliError) return failed('session', err);
    throw err;
  }
}

/** The key goes only where a session token may; see `bearerOriginRefusal`. */
function keyRefusal(m: Machine, origin: string): Skipped | null {
  let refusal;
  try {
    refusal = bearerOriginRefusal(m, origin);
  } catch (err) {
    if (err instanceof UsageError) return { name: 'key', code: 'usage', message: err.message, hint: usageHint('status') };
    throw err;
  }
  if (refusal === null) return null;
  return {
    name: 'key',
    code: 'usage',
    message: `${API_KEY_ENV} is only sent to ${DEFAULT_ORIGIN}, or to the origin in ERKLE_TOKEN_ORIGIN (https, or http to localhost); this command talks to ${origin}. The key was not checked.`,
    hint: `Set ERKLE_TOKEN_ORIGIN=${origin} if that server is yours, or drop --url and ERKLE_URL.`,
  };
}

const accessLabel = (a: { readOnly: boolean; teamWrites: boolean }) =>
  a.readOnly ? 'read-only' : a.teamWrites ? 'read and write' : 'read and write, to its listed projects only';

const NOT_REGISTERED = /^Repository \S+ is not registered/;

async function keyCheck(m: Machine, version: string, url: string, key: string, repo: string | null): Promise<Check> {
  const origin = apiOrigin(url);
  let result;
  try {
    result = await callTool(m, version, url, key, 'erkle_context', repo ? { repo } : {});
  } catch (err) {
    if (err instanceof KeyRejectedError) {
      const why = err.reason === 'not_recognized' ? 'is not recognized' : err.reason === 'unknown' ? 'was rejected' : `is ${err.reason}`;
      return failed('key', { code: 'key_rejected', reason: err.reason, message: `${origin} says ${API_KEY_ENV} ${why}.`, hint: KEYS_HINT });
    }
    if (err instanceof CliError) return failed('key', err);
    throw err;
  }

  const repository = repo ? displayRemote(repo) : null;
  if (result.isError) {
    // The key was accepted; the repository just isn't registered with its team.
    if (repository && NOT_REGISTERED.test(result.text)) {
      return {
        name: 'key',
        ok: true,
        message: `The key works. Repository ${repository} is not registered with its team.`,
        hint: 'A team owner or admin can register it on the dashboard or with the repo_register tool.',
        team: null,
        access: null,
        repository: { remote: repository, registered: false, linkedProjects: [] },
      };
    }
    return failed('key', { code: 'forbidden', message: result.text || `${origin} refused the key's request.` });
  }

  const sc = result.structuredContent ?? {};
  const t = sc.team as { id?: unknown; name?: unknown; role?: unknown } | undefined;
  const a = sc.access as { readOnly?: unknown; teamWrites?: unknown } | undefined;
  const ctxInfo = sc.context as { repository?: unknown; projects?: unknown } | undefined;
  if (!t || typeof t.id !== 'string' || typeof t.name !== 'string') {
    return failed('key', serverReplyError(origin, 'erkle_context'));
  }
  const team = { id: t.id, name: t.name, role: typeof t.role === 'string' ? t.role : null };
  const access = a ? { readOnly: a.readOnly === true, teamWrites: a.teamWrites === true } : null;
  const linked = Array.isArray(ctxInfo?.projects) ? ctxInfo.projects.filter((p): p is string => typeof p === 'string') : [];
  const repoReport = repository && ctxInfo ? { remote: repository, registered: true, linkedProjects: linked } : null;

  let message = `Team ${team.name}${team.role ? ` (${team.role})` : ''}${access ? `, ${accessLabel(access)}` : ''}.`;
  if (repoReport) {
    message += ` Repository ${repository} is registered; ${linked.length ? `linked projects: ${linked.join(', ')}` : 'you are in no project that links it, so only team memories apply'}.`;
  }
  return { name: 'key', ok: true, message, team, access: access && { ...access, label: accessLabel(access) }, repository: repoReport };
}

function printReport(ctx: Context, agents: AgentReport[], checks: Check[], skipped: Skipped[]): void {
  const out = ctx.io.out;
  const width = Math.max(...agents.map((a) => a.label.length)) + 2;
  const line = (scope: string, c: ConfigReport) => `${scope} ${c.path}: ${c.auth}${c.url ? `  ${c.url}` : ''}`;
  out('Agents:\n');
  for (const a of agents) {
    const rows = [...(a.project ? [line('project', a.project)] : []), line('user', a.user)];
    rows.forEach((r, i) => out(`  ${(i === 0 ? a.label : '').padEnd(width)}${r}\n`));
  }
  for (const c of checks) {
    out(`${c.ok ? '✓' : '✖'} ${c.name === 'session' ? 'Session' : 'Key'}: ${c.message}${c.code ? ` (${c.code}${c.reason ? `: ${c.reason}` : ''})` : ''}\n`);
    if (c.hint) out(`  ${c.hint}\n`);
  }
  for (const s of skipped) {
    out(`- ${s.name === 'session' ? 'Session' : 'Key'}: ${s.message}\n  ${s.hint}\n`);
  }
}

async function runStatus(args: string[], ctx: Context): Promise<Outcome> {
  const { m, io } = ctx;
  const { values: v, positionals } = parseCommand('status', args, {});
  noPositionals('status', positionals);
  const url = mcpUrl(v.url, m.env);
  const origin = apiOrigin(url);
  const { repoRoot, origin: remote } = probe(m);

  const agents = readAgents(m, repoRoot);
  const checks: Check[] = [];
  const skipped: Skipped[] = [];
  const add = (r: Check | Skipped) => ('ok' in r ? checks.push(r) : skipped.push(r));

  const key = m.env[API_KEY_ENV];
  const [session, keyResult] = await Promise.all([
    sessionCheck(m, io.version, origin),
    key ? (keyRefusal(m, origin) ?? keyCheck(m, io.version, url, key, remote)) : null,
  ]);
  add(session);

  const keyMode = agents.some((a) => a.project?.auth === 'key' || a.user.auth === 'key');
  if (keyResult) {
    add(keyResult);
  } else if (keyMode) {
    add(failed('key', { code: 'key_rejected', reason: 'missing', message: `An agent is set to use ${API_KEY_ENV}, but it is not set in this environment.`, hint: ENV_FILE_HINT }));
  } else {
    skipped.push({ name: 'key', message: `${API_KEY_ENV} is not set.`, hint: 'Run `erkle keys create --env-file ~/.erkle.env` to make one, then load that file.' });
  }

  printReport(ctx, agents, checks, skipped);
  const data = { server: origin, repository: remote ? displayRemote(remote) : null, agents, checks, skipped };
  const failures = checks.filter((c) => !c.ok);
  if (failures.length) {
    const first = failures[0]!;
    throw new CliError(first.code!, failures.length === 1 ? `Status check failed: ${first.message}` : `${failures.length} status checks failed. First: ${first.message}`, {
      ...(first.hint !== undefined && { hint: first.hint }),
      ...(first.reason !== undefined && { reason: first.reason }),
      data,
    });
  }
  return { data };
}

export const status: Command = { name: 'status', summary: 'show how agents connect and check the session and key', help: HELP, run: runStatus };
