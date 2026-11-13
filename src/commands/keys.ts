import { randomBytes } from 'node:crypto';
import { listPending, readSession } from '../credentials.js';
import { checkEnvFile, envFilePath, gitExposure, shellWord, writeEnvFile } from '../env-file.js';
import { Api, apiOrigin, connect, mcpUrl, serverReplyError } from '../http.js';
import { CliError, UsageError } from '../output.js';
import { API_KEY_ENV, keySnippets } from '../text.js';
import { awaitApproval, loadPending, type PendingApproval, parseDeviceRequest, WAIT_HELP, WAIT_OPTIONS, waitFlags } from '../wait.js';
import { COMMON_HELP, type Command, type Context, envHelp, jsonHelp, noPositionals, type Outcome, parseCommand, SESSION_ENV, usageHint } from './command.js';
import { fetchProjects, requireActiveTeam, teamScoped } from './team.js';

type Permission = 'read' | 'read_write';

interface KeyView {
  id: string;
  name: string;
  displayPrefix: string;
  permission: Permission;
  restricted: boolean;
  projects: { id: string; name: string }[];
  creator: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

/** A key just made, by either path. `id` is null only if it could not be looked up after a browser approval. */
interface Created {
  id: string | null;
  name: string;
  displayPrefix: string;
  permission: Permission;
  restricted: boolean;
  projects: { id: string; name: string }[];
  team: { id: string; name: string } | null;
  expiresAt: string;
  secret: string;
}

const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;
const MAX_NAME = 100;
// The server's display prefix: `erk_` and the key's next six characters.
const DISPLAY_PREFIX_LENGTH = 10;
const KEY_KIND = 'key';
/** An API key as the server makes them: `erk_`, 43 base62 characters, and a 6-character base62 checksum. */
const API_KEY_FORMAT = /^erk_[0-9A-Za-z]{49}$/;

const permissionText = (p: Permission) => (p === 'read_write' ? 'read and write' : 'read');
const projectsText = (k: { restricted: boolean; projects: { name: string }[] }) =>
  !k.restricted ? 'all projects in the team' : k.projects.length ? k.projects.map((p) => p.name).join(', ') : 'none left (team-wide memories only)';
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

function defaultName(hostname: string): string {
  const suffix = '(erkle cli)';
  const host = hostname.trim().slice(0, MAX_NAME - suffix.length - 1);
  return host ? `${host} ${suffix}` : 'erkle cli';
}

function parseExpiry(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EXPIRY_DAYS;
  const days = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(days >= 1 && days <= MAX_EXPIRY_DAYS)) {
    throw new UsageError(`--expires takes a whole number of days from 1 to ${MAX_EXPIRY_DAYS}, got ${value}`, { hint: usageHint('keys create') });
  }
  return days;
}

function parseSlugs(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const slugs = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!slugs.length) throw new UsageError('--projects takes comma-separated project slugs', { hint: 'Run `erkle projects` to list them.' });
  return slugs;
}

const KEYS_CREATE_HELP = `Usage: erkle keys create [--name <n>] [--write] [--projects <slugs>] [--expires <days>]
                         [--env-file <path>] [--no-wait | --resume [<id>]] [--timeout <s>]

Create an API key for the session's active team. The key is shown once.
With --env-file it is written to that file instead and left out of all output.

If the team requires browser approval for CLI keys, this opens a key request:
approve it in a browser, and the CLI collects the key. Without a terminal it
waits up to 90 seconds, then returns a pending result with the command that
collects the key later.

Options:
  --name <n>          a name for the key (default: "<hostname> (erkle cli)")
  --write             let the key write memories (default: read only)
  --projects <slugs>  limit the key to these projects, comma-separated; see \`erkle projects\`
  --expires <days>    days until the key expires, 1 to ${MAX_EXPIRY_DAYS} (default ${DEFAULT_EXPIRY_DAYS})
  --env-file <path>   write ERKLE_API_KEY=<key> to this file (mode 0600), keeping its other lines
${WAIT_HELP}${COMMON_HELP}
${jsonHelp([
  ['status', '"created", or "pending" with approvalUrl, userCode, expiresAt, resume (the command that collects the key), and requestId'],
  ['id', "the key's id (null if it could not be looked up after a browser approval)"],
  ['name, displayPrefix', "the key's name and its first characters, as shown in lists"],
  ['permission', '"read" or "read_write"'],
  ['restricted, projects', 'whether the key is limited to projects, and those projects: {id, name}'],
  ['team', '{id, name}'],
  ['expiresAt', 'when the key expires'],
  ['approvedInBrowser', 'true when the team required browser approval'],
  ['secret', 'the key itself, shown once; left out with --env-file'],
  ['envFile', 'the file the key was written to, with --env-file'],
])}
${envHelp(SESSION_ENV)}`;

interface KeyPending extends PendingApproval {
  envFile: string | null;
}

function parseApproved(reply: Record<string, unknown>, origin: string, name: string): Created {
  const team = reply.team as { id?: unknown; name?: unknown } | null | undefined;
  // Checked before the key is written or printed: a malformed one is never shown or stored.
  if (typeof reply.key !== 'string' || !API_KEY_FORMAT.test(reply.key) || typeof reply.expiresAt !== 'string') {
    throw new CliError('server', `${origin} approved the key request but sent no key.`, { hint: 'Run `erkle keys list` to check, then `erkle keys create` again.' });
  }
  return {
    id: null,
    name,
    displayPrefix: reply.key.slice(0, DISPLAY_PREFIX_LENGTH),
    permission: reply.permission === 'read_write' ? 'read_write' : 'read',
    restricted: reply.restricted === true,
    projects: Array.isArray(reply.projects) ? (reply.projects as { id: string; name: string }[]) : [],
    team: team && typeof team.id === 'string' && typeof team.name === 'string' ? { id: team.id, name: team.name } : null,
    expiresAt: reply.expiresAt,
    secret: reply.key,
  };
}

/** The new key's id and name from the list, so it can be revoked by id. Best effort: the key is made either way. */
async function lookUpId(ctx: Context, url: string, created: Created): Promise<Created> {
  try {
    const api = await connect(ctx.m, ctx.io.version, url);
    const r = await api.get<{ items?: KeyView[] }>('/api/api-keys');
    const found = r?.items?.find((k) => k.displayPrefix === created.displayPrefix);
    return found ? { ...created, id: found.id, name: found.name } : created;
  } catch {
    return created;
  }
}

/** Writes the env file after the key exists; a failure says which key to revoke, since its secret is now lost. */
function saveToEnvFile(path: string, created: Created): void {
  try {
    writeEnvFile(path, created.secret);
  } catch (err) {
    const which = created.id ?? created.displayPrefix;
    throw new CliError('file_unsafe', `${(err as Error).message} Key ${which} was created but not saved anywhere.`, {
      hint: created.id ? `Run \`erkle keys revoke ${created.id}\`, then create another.` : 'Run `erkle keys list` to find it and revoke it, then create another.',
    });
  }
}

function report(ctx: Context, created: Created, envFile: string | null, url: string, approved: boolean): Outcome {
  const { io } = ctx;
  const label = `${created.name} (${created.displayPrefix}${created.id ? `, id ${created.id}` : ''})`;
  if (envFile) {
    io.out(`✓ Created API key ${label} and wrote it to ${envFile}.\n`);
  } else if (ctx.json) {
    io.out(`✓ Created API key ${label}. The key is in the "secret" field of the JSON result; it is not shown again.\n`);
  } else {
    io.out(`✓ Created API key ${label}. Copy it now; it is not shown again:\n\n  ${created.secret}\n\n`);
  }
  if (created.team) io.out(`  Team: ${created.team.name}\n`);
  io.out(`  Permission: ${permissionText(created.permission)}\n  Projects: ${projectsText(created)}\n  Expires: ${day(created.expiresAt)}\n\n`);
  if (envFile) {
    io.out(
      `Load it in this shell, and add the same line to your shell profile (~/.zshrc, ~/.bashrc) so agents started later have it:\n  set -a; . ${shellWord(envFile)}; set +a\n\n`,
    );
  } else {
    io.out(`Set it where your agents run:\n  export ${API_KEY_ENV}=<the key above>\n\n`);
  }
  io.out(keySnippets(url));

  const { secret, ...view } = created;
  return { data: { status: 'created', ...view, approvedInBrowser: approved, ...(envFile ? { envFile } : { secret }) } };
}

async function runKeysCreate(args: string[], ctx: Context): Promise<Outcome> {
  const { m, io } = ctx;
  const { values: v, positionals } = parseCommand('keys create', args, {
    name: { type: 'string' },
    write: { type: 'boolean', default: false },
    projects: { type: 'string' },
    expires: { type: 'string' },
    'env-file': { type: 'string' },
    ...WAIT_OPTIONS,
  });
  const flags = waitFlags('keys create', v, positionals);
  const url = mcpUrl(v.url, m.env);
  const origin = apiOrigin(url);
  const urlFlag = v.url !== undefined ? ` --url ${url}` : '';
  const restartHint = `Run \`erkle keys create${urlFlag}\` again.`;
  let envFile = v['env-file'] !== undefined ? envFilePath(m, v['env-file']) : null;

  let name: string;
  let request: KeyPending;
  if (flags.resume) {
    // Fail on an unsafe config directory before looking for the request.
    readSession(m, origin);
    let id = flags.resumeId;
    if (id === null) {
      const found = listPending(m, KEY_KIND, origin);
      if (!found.length) throw new CliError('not_found', 'No pending key request to resume.', { hint: 'Run `erkle keys create`.' });
      if (found.length > 1) {
        throw new UsageError(`More than one key request is pending: ${found.map((p) => p.id).join(', ')}`, { hint: 'Run `erkle keys create --resume <id>`.' });
      }
      id = found[0]!.id;
    }
    request = loadPending(ctx, id, KEY_KIND, origin, 'Run `erkle keys create`.') as KeyPending;
    envFile ??= typeof request.envFile === 'string' ? request.envFile : null;
    name = typeof request.name === 'string' ? request.name : defaultName(m.hostname());
    if (envFile) checkEnvFile(envFile);
  } else {
    const expiresInDays = parseExpiry(v.expires);
    const slugs = parseSlugs(v.projects);
    name = v.name ?? defaultName(m.hostname());
    if (name.trim() === '' || name.length > MAX_NAME) throw new UsageError(`--name takes 1 to ${MAX_NAME} characters`, { hint: usageHint('keys create') });
    // Before any key exists, so a bad path never costs one.
    if (envFile) checkEnvFile(envFile);

    const api = await connect(m, io.version, url);
    const me = await requireActiveTeam(api);
    let projectIds: string[] | undefined;
    if (slugs) {
      const projects = await fetchProjects(api);
      const unknown = slugs.filter((s) => !projects.some((p) => p.slug === s));
      if (unknown.length) {
        const valid = projects.length ? `Projects in ${me.activeTeam.name}: ${projects.map((p) => p.slug).join(', ')}.` : `${me.activeTeam.name} has no projects.`;
        throw new CliError('not_found', `Unknown project ${unknown.length === 1 ? 'slug' : 'slugs'}: ${unknown.join(', ')}. ${valid}`, {
          hint: 'Run `erkle projects` to list them.',
        });
      }
      projectIds = slugs.map((s) => projects.find((p) => p.slug === s)!.id);
    }
    const body = { name, permission: (v.write ? 'read_write' : 'read') as Permission, expiresInDays, ...(projectIds && { projectIds }) };

    try {
      const r = await teamScoped(api, () => api.post<Partial<KeyView> & { secret?: unknown }>('/api/api-keys', body));
      if (!r || typeof r.secret !== 'string' || !API_KEY_FORMAT.test(r.secret) || typeof r.id !== 'string' || typeof r.displayPrefix !== 'string') {
        throw serverReplyError(origin, 'POST /api/api-keys');
      }
      const created: Created = {
        id: r.id,
        name: typeof r.name === 'string' ? r.name : name,
        displayPrefix: r.displayPrefix,
        permission: r.permission === 'read_write' ? 'read_write' : 'read',
        restricted: r.restricted === true,
        projects: Array.isArray(r.projects) ? r.projects : [],
        team: { id: me.activeTeam.id, name: me.activeTeam.name },
        expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : '',
        secret: r.secret,
      };
      if (envFile) saveToEnvFile(envFile, created);
      warnIfExposed(ctx, envFile);
      return report(ctx, created, envFile, url, false);
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'approval_required')) throw err;
    }

    io.out(`${me.activeTeam.name} requires browser approval for keys made from the CLI.\n`);
    const opened = await teamScoped(api, () => api.post('/api/key-requests/for-cli', body));
    request = { id: `key-${randomBytes(8).toString('hex')}`, kind: KEY_KIND, origin, envFile, name, ...parseDeviceRequest(opened, origin) };
  }

  const result = await awaitApproval({
    ctx,
    api: new Api(m, io.version, origin, null),
    pollPath: '/api/key-requests/poll',
    request,
    resumed: flags.resume,
    flags,
    label: 'key request',
    resumeCommand: `erkle keys create --resume ${request.id}${urlFlag}`,
    restartHint,
    onApproved: async (reply) => {
      const created = parseApproved(reply, origin, name);
      if (envFile) saveToEnvFile(envFile, created);
      return created;
    },
  });
  if (result.status === 'pending') return { data: { ...result.data, requestId: request.id } };
  const created = await lookUpId(ctx, url, result.value);
  warnIfExposed(ctx, envFile);
  return report(ctx, created, envFile, url, true);
}

function warnIfExposed(ctx: Context, envFile: string | null): void {
  if (!envFile) return;
  const warning = gitExposure(ctx.m, envFile);
  if (warning) ctx.io.err(`▲ ${warning}\n`);
}

export const keysCreate: Command = { name: 'keys create', summary: 'create an API key for the active team', help: KEYS_CREATE_HELP, run: runKeysCreate };

const KEYS_LIST_HELP = `Usage: erkle keys list

List API keys in the active team. Members see their own keys; owners and
admins see every key in the team.

Options:
${COMMON_HELP}
${jsonHelp([
  [
    'items',
    'the keys: {id, name, displayPrefix, permission, restricted, projects, creator, createdAt, expiresAt, lastUsedAt, revokedAt, status}, where status is "active", "expired", or "revoked". Never the key itself.',
  ],
])}
${envHelp(SESSION_ENV)}`;

async function listKeys(api: Api): Promise<KeyView[]> {
  const r = await teamScoped(api, () => api.get<{ items?: unknown }>('/api/api-keys'));
  if (!r || !Array.isArray(r.items)) throw serverReplyError(api.origin, 'GET /api/api-keys');
  return r.items as KeyView[];
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')}\n`).join('');
}

async function runKeysList(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('keys list', args, {});
  noPositionals('keys list', positionals);
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const items = await listKeys(api);
  if (!items.length) {
    io.out('No API keys. Run `erkle keys create` to make one.\n');
  } else {
    io.out(
      table([
        ['ID', 'NAME', 'PREFIX', 'PERMISSION', 'PROJECTS', 'CREATOR', 'EXPIRES', 'LAST USED', 'STATUS'],
        ...items.map((k) => [
          k.id,
          k.name,
          k.displayPrefix,
          k.permission,
          k.restricted ? k.projects.map((p) => p.name).join(', ') || 'none' : 'all',
          k.creator?.name ?? '-',
          day(k.expiresAt),
          day(k.lastUsedAt),
          k.status,
        ]),
      ]),
    );
  }
  return { data: { items } };
}

export const keysList: Command = { name: 'keys list', summary: 'list API keys in the active team', help: KEYS_LIST_HELP, run: runKeysList };

const KEYS_REVOKE_HELP = `Usage: erkle keys revoke <id> [--yes]

Revoke an API key at once; agents using it stop working. Find ids with
\`erkle keys list\`. Asks first on a terminal; without one, needs --yes.

Options:
  -y, --yes           revoke without asking
${COMMON_HELP}
${jsonHelp([
  ['status', '"revoked", or "cancelled" when you answered no'],
  ['id', "the key's id"],
  ['name, displayPrefix', 'the revoked key, when revoked'],
])}
${envHelp(SESSION_ENV)}`;

async function runKeysRevoke(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('keys revoke', args, { yes: { type: 'boolean', short: 'y', default: false } });
  if (positionals.length !== 1) {
    throw new UsageError(positionals.length ? `unexpected argument: ${positionals.slice(1).join(' ')}` : 'keys revoke needs a key id', {
      hint: 'Run `erkle keys list` to find key ids.',
    });
  }
  const id = positionals[0]!;
  if (!v.yes && !io.interactive) {
    throw new UsageError('erkle keys revoke needs --yes without a terminal', { hint: `Run \`erkle keys revoke ${id} --yes\`.` });
  }
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const key = (await listKeys(api)).find((k) => k.id === id);
  if (!key) throw new CliError('not_found', `No API key ${id} that you can revoke in the active team.`, { hint: 'Run `erkle keys list` to find key ids.' });
  const label = `${key.name} (${key.displayPrefix})`;
  if (!v.yes) {
    const ok = await io.prompts.confirm(`Revoke API key ${label}? Agents using it stop working at once.`);
    if (!ok) {
      io.out('Cancelled. Nothing revoked.\n');
      return { data: { status: 'cancelled', id } };
    }
  }
  await teamScoped(api, () => api.delete(`/api/api-keys/${encodeURIComponent(id)}`));
  io.out(`✓ Revoked API key ${label}.\n`);
  return { data: { status: 'revoked', id, name: key.name, displayPrefix: key.displayPrefix } };
}

export const keysRevoke: Command = { name: 'keys revoke', summary: 'revoke an API key', help: KEYS_REVOKE_HELP, run: runKeysRevoke };
