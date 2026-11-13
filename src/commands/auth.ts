import { createHash } from 'node:crypto';
import { DEFAULT_ORIGIN, readSession, removeSession, resolveCredential, saveSession } from '../credentials.js';
import { Api, apiOrigin, assertBearerAllowed, connect, HttpError, LOGIN_HINT, mcpUrl } from '../http.js';
import { CliError, UsageError } from '../output.js';
import { awaitApproval, loadPending, parseDeviceRequest, WAIT_HELP, WAIT_OPTIONS, waitFlags } from '../wait.js';
import { COMMON_HELP, type Command, type Context, envHelp, jsonHelp, noPositionals, type Outcome, parseCommand, SESSION_ENV, usageHint } from './command.js';
import { fetchMe, printTeams } from './team.js';

/** Fields added to every result for a server other than erkle.ai, so nobody signs in somewhere by accident. */
function serverField(origin: string): { server?: string } {
  return origin === DEFAULT_ORIGIN ? {} : { server: origin };
}

const LOGIN_HELP = `Usage: erkle login [--no-wait | --resume [<id>]] [--timeout <s>]

Sign in to Erkle from this terminal. Prints a link and a code; approve in a
browser on any device and pick the team to start on. The session is stored
for this server only and lasts 30 days.

Without a terminal, waits up to 90 seconds and then returns a pending result
with the command that collects the sign-in later.

Options:
${WAIT_HELP}${COMMON_HELP}
${jsonHelp([
  ['status', '"signed_in", or "pending" with approvalUrl, userCode, expiresAt, and resume (the command that collects the sign-in)'],
  ['account', '{email}, or null'],
  ['team', 'the starting team {id, name}, or null'],
  ['expiresAt', 'when the session expires'],
  ['server', "the server's origin, only when it is not https://erkle.ai"],
])}
The session token is never printed; \`erkle token\` is the only command that prints one.

${envHelp(['ERKLE_URL', 'ERKLE_CONFIG_DIR'])}`;

/** One pending sign-in per server, so `--resume` needs no id. */
const loginPendingId = (origin: string) => `login-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;

interface LoginApproved {
  token: string;
  expiresAt: string | null;
  account: { email: string } | null;
  team: { id: string; name: string } | null;
}

function parseApproved(reply: Record<string, unknown>, origin: string): LoginApproved {
  if (typeof reply.token !== 'string' || !reply.token.startsWith('erkc_')) {
    throw new CliError('server', `${origin} approved the sign-in but sent no session.`, { hint: 'Run `erkle login` again.' });
  }
  const account = reply.account as { email?: unknown } | null | undefined;
  const team = reply.team as { id?: unknown; name?: unknown } | null | undefined;
  return {
    token: reply.token,
    expiresAt: typeof reply.expiresAt === 'string' ? reply.expiresAt : null,
    account: account && typeof account.email === 'string' ? { email: account.email } : null,
    team: team && typeof team.id === 'string' && typeof team.name === 'string' ? { id: team.id, name: team.name } : null,
  };
}

async function runLogin(args: string[], ctx: Context): Promise<Outcome> {
  const { m, io } = ctx;
  const { values: v, positionals } = parseCommand('login', args, WAIT_OPTIONS);
  const flags = waitFlags('login', v, positionals);
  const url = mcpUrl(v.url, m.env);
  const origin = apiOrigin(url);
  // The session comes back over this connection and is sent on every later call.
  assertBearerAllowed(origin);
  // Fail on an unsafe config directory now, not after the person approves.
  readSession(m, origin);

  const resumeCommand = `erkle login --resume${v.url !== undefined ? ` --url ${url}` : ''}`;
  const restartHint = `Run \`erkle login${v.url !== undefined ? ` --url ${url}` : ''}\` again.`;
  const api = new Api(m, io.version, origin, null);

  let request;
  if (flags.resume) {
    request = loadPending(ctx, flags.resumeId ?? loginPendingId(origin), 'login', origin, LOGIN_HINT);
  } else {
    const label = m.hostname().trim().slice(0, 100);
    const opened = await api.post('/api/cli/login-requests', label ? { deviceLabel: label } : {});
    request = { id: loginPendingId(origin), kind: 'login', origin, ...parseDeviceRequest(opened, origin) };
  }
  if (origin !== DEFAULT_ORIGIN) io.err(`Signing in to ${origin}, not ${DEFAULT_ORIGIN}.\n`);

  const result = await awaitApproval({
    ctx,
    api,
    pollPath: '/api/cli/login-requests/poll',
    request,
    resumed: flags.resume,
    flags,
    label: 'sign-in',
    resumeCommand,
    restartHint,
    onApproved: async (reply) => {
      const s = parseApproved(reply, origin);
      const previous = readSession(m, origin);
      saveSession(m, origin, { token: s.token, expiresAt: s.expiresAt, account: s.account, team: s.team });
      // Only after the new one is stored, so a failure here never leaves this machine signed out.
      if (previous && previous.token !== s.token) {
        await new Api(m, io.version, origin, previous.token).post('/api/cli/logout', {}).catch(() => undefined);
      }
      return s;
    },
  });
  if (result.status === 'pending') return { data: { ...result.data, ...serverField(origin) } };

  const s = result.value;
  io.out(`✓ Signed in${s.account ? ` as ${s.account.email}` : ''}${s.team ? `, team ${s.team.name}` : ', no team selected'}.\n`);
  if (!s.team) io.out('  Run `erkle team use <team>` to pick one.\n');
  return { data: { status: 'signed_in', account: s.account, team: s.team, expiresAt: s.expiresAt, ...serverField(origin) } };
}

export const login: Command = { name: 'login', summary: 'sign in to Erkle from this terminal', help: LOGIN_HELP, run: runLogin };

const LOGOUT_HELP = `Usage: erkle logout [--revoke-keys]

Sign out: ends the session on the server and removes it from this machine.

Options:
  --revoke-keys       also revoke every API key this session created
${COMMON_HELP}
${jsonHelp([
  ['status', '"signed_out"'],
  ['source', '"file" (the stored sign-in, now removed) or "env" (ERKLE_TOKEN, which stays set)'],
  ['revokedKeys', 'how many keys --revoke-keys revoked'],
  ['sessionAlreadyEnded', 'true when the server had already ended the session'],
  ['server', "the server's origin, only when it is not https://erkle.ai"],
])}
${envHelp(SESSION_ENV)}`;

async function runLogout(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('logout', args, { 'revoke-keys': { type: 'boolean', default: false } });
  noPositionals('logout', positionals);
  const origin = apiOrigin(mcpUrl(v.url, m.env));
  const cred = resolveCredential(m, origin);
  if (!cred) throw new CliError('not_signed_in', `Not signed in to ${origin}.`, { hint: LOGIN_HINT });

  const revokeKeys = v['revoke-keys'];
  let revokedKeys = 0;
  let alreadyEnded = false;
  try {
    const r = await new Api(m, io.version, origin, cred.token).post<{ revokedKeys?: unknown }>('/api/cli/logout', revokeKeys ? { revokeKeys: true } : {});
    revokedKeys = typeof r?.revokedKeys === 'number' ? r.revokedKeys : 0;
  } catch (err) {
    // A session the server already ended is as good as signed out; anything else, keep it to retry.
    if (!(err instanceof HttpError && err.status === 401) || cred.source === 'env') throw err;
    alreadyEnded = true;
  }

  if (cred.source === 'file') removeSession(m, origin);
  io.out(alreadyEnded ? `✓ Removed the session for ${origin}; the server had already ended it.\n` : `✓ Signed out of ${origin}.\n`);
  if (revokeKeys && !alreadyEnded) io.out(`  Revoked ${revokedKeys} ${revokedKeys === 1 ? 'key' : 'keys'}.\n`);
  if (revokeKeys && alreadyEnded) io.out('  Keys it created were not revoked; sign in and run `erkle keys list` to find them.\n');
  if (cred.source === 'env') io.err('ERKLE_TOKEN is still set in this environment; unset it, or remove it from where it is defined.\n');
  return {
    data: { status: 'signed_out', source: cred.source, revokedKeys, sessionAlreadyEnded: alreadyEnded, ...serverField(origin) },
  };
}

export const logout: Command = { name: 'logout', summary: 'sign out and end this session', help: LOGOUT_HELP, run: runLogout };

const WHOAMI_HELP = `Usage: erkle whoami

Show the signed-in account, the session's active team, every team you belong
to, and when the session expires.

Options:
${COMMON_HELP}
${jsonHelp([
  ['user', '{id, email, name}'],
  ['activeTeam', '{id, name, slug, role, cliKeysNeedApproval}, or null'],
  ['teams', 'every team you belong to, in the same shape'],
  ['session', '{id, expiresAt, deviceLabel}'],
  ['server', "the server's origin, only when it is not https://erkle.ai"],
])}
${envHelp(SESSION_ENV)}`;

async function runWhoami(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('whoami', args, {});
  noPositionals('whoami', positionals);
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const me = await fetchMe(api);

  io.out(`Signed in to ${api.origin} as ${me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email}\n`);
  io.out(me.activeTeam ? `Active team: ${me.activeTeam.name} (${me.activeTeam.slug}, ${me.activeTeam.role})\n` : 'Active team: none. Run `erkle team use <team>`.\n');
  if (me.teams.length) {
    io.out('Teams:\n');
    printTeams(io, me, '  ');
  }
  if (me.session?.expiresAt) io.out(`Session expires ${me.session.expiresAt.slice(0, 10)}.\n`);
  return { data: { user: me.user, activeTeam: me.activeTeam, teams: me.teams, session: me.session, ...serverField(api.origin) } };
}

export const whoami: Command = { name: 'whoami', summary: 'show the signed-in account and teams', help: WHOAMI_HELP, run: runWhoami };

const TOKEN_HELP = `Usage: erkle token [--name <label>] [--yes]

Create a separate 30-day session for a CI secret and print its token. Signing
in or out on this machine never affects it. Store it as ERKLE_TOKEN.

The token can create API keys for your teams. Treat it like a password.

Options:
  --name <label>      a label for the session, shown on the dashboard
  -y, --yes           required without a terminal
${COMMON_HELP}
${jsonHelp([
  ['token', 'the new session token'],
  ['expiresAt', 'when it expires'],
  ['name', 'its label, or null'],
  ['server', "the server's origin, only when it is not https://erkle.ai"],
])}
${envHelp(SESSION_ENV)}`;

async function runToken(args: string[], { m, io, json }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('token', args, {
    name: { type: 'string' },
    yes: { type: 'boolean', short: 'y', default: false },
  });
  noPositionals('token', positionals);
  if (v.name !== undefined && (v.name.trim() === '' || v.name.length > 100)) {
    throw new UsageError('--name takes 1 to 100 characters', { hint: usageHint('token') });
  }
  if (!io.interactive && !v.yes) {
    throw new UsageError('erkle token prints a secret that can create API keys; without a terminal it needs --yes', {
      hint: 'Run `erkle token --yes` if this output goes somewhere safe.',
    });
  }
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const r = await api.post<{ token?: unknown; expiresAt?: unknown; deviceLabel?: unknown }>('/api/cli/sessions', v.name !== undefined ? { name: v.name } : {});
  if (typeof r?.token !== 'string' || !r.token.startsWith('erkc_')) {
    throw new CliError('server', `${api.origin} did not return a session token.`, { hint: 'Run the same command again in a minute.' });
  }
  const expiresAt = typeof r.expiresAt === 'string' ? r.expiresAt : null;
  if (io.interactive) io.err('This token can create API keys for your teams. Store it as a secret (ERKLE_TOKEN); never commit it.\n');
  // With --json, io.out goes to stderr, which CI logs capture: the token stays in the document only.
  if (json) io.out('The token is in the "token" field of the JSON result; it is not shown again.\n');
  else io.out(`${r.token}\n`);
  if (expiresAt) io.err(`Expires ${expiresAt.slice(0, 10)}.\n`);
  return { data: { token: r.token, expiresAt, name: typeof r.deviceLabel === 'string' ? r.deviceLabel : null, ...serverField(api.origin) } };
}

export const token: Command = { name: 'token', summary: 'create a separate session token for CI', help: TOKEN_HELP, run: runToken };
