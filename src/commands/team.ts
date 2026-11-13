import { type Api, connect, HttpError, mcpUrl, serverReplyError, TEAM_HINT } from '../http.js';
import { CliError, UsageError } from '../output.js';
import { COMMON_HELP, type Command, type Context, envHelp, jsonHelp, noPositionals, type Outcome, parseCommand, SESSION_ENV, usageHint } from './command.js';

export interface Team {
  id: string;
  name: string;
  slug: string;
  role: string;
  cliKeysNeedApproval?: boolean;
}

export interface Me {
  user: { id: string; email: string; name: string | null };
  activeTeam: Team | null;
  teams: Team[];
  session: { id: string; expiresAt: string; deviceLabel: string | null };
}

export interface Project {
  id: string;
  slug: string;
  name: string;
}

function parseMe(raw: unknown, origin: string): Me {
  const me = raw as Me | null;
  if (!me || typeof me.user?.email !== 'string' || !Array.isArray(me.teams)) throw serverReplyError(origin, '/api/cli/me');
  // The server's activeTeam leaves out cliKeysNeedApproval; its teams[] entry has it.
  const active = me.activeTeam ? (me.teams.find((t) => t.id === me.activeTeam!.id) ?? me.activeTeam) : null;
  return { ...me, activeTeam: active };
}

export async function fetchMe(api: Api): Promise<Me> {
  return parseMe(await api.get('/api/cli/me'), api.origin);
}

/** "acme (Acme), beta (Beta)", for hints that list the choices. */
export const teamChoices = (teams: Team[]) => teams.map((t) => `${t.slug} (${t.name})`).join(', ');

function noTeamError(teams: Team[] | null, message = 'No active team for this session.'): CliError {
  const list = teams === null ? '' : teams.length ? ` Your teams: ${teamChoices(teams)}.` : ' You are not a member of any team yet.';
  return new CliError('no_team', `${message}${list}`, { hint: TEAM_HINT });
}

/**
 * Runs a call that needs the session's active team. No active team (400) and
 * an active team the person has since left (403) both become `no_team`, with
 * the teams to choose from.
 */
export async function teamScoped<T>(api: Api, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof CliError) || !(err.code === 'no_team' || (err instanceof HttpError && err.status === 403))) throw err;
    const teams = await fetchMe(api).then(
      (me) => me.teams,
      () => null,
    );
    throw noTeamError(teams, err.code === 'no_team' ? 'No active team for this session.' : 'This session\'s active team is no longer one of yours.');
  }
}

/** The session's identity, failing with `no_team` when it has no active team. */
export async function requireActiveTeam(api: Api): Promise<Me & { activeTeam: Team }> {
  const me = await fetchMe(api);
  if (!me.activeTeam) throw noTeamError(me.teams);
  return me as Me & { activeTeam: Team };
}

export async function fetchProjects(api: Api): Promise<Project[]> {
  const r = await teamScoped(api, () => api.get<{ items?: unknown }>('/api/cli/projects'));
  if (!r || !Array.isArray(r.items)) throw serverReplyError(api.origin, '/api/cli/projects');
  return r.items as Project[];
}

export function printTeams(io: Context['io'], me: Me, indent = ''): void {
  if (!me.teams.length) {
    io.out(`${indent}You are not a member of any team yet.\n`);
    return;
  }
  for (const t of me.teams) {
    const mark = me.activeTeam?.id === t.id ? '*' : ' ';
    io.out(`${indent}${mark} ${t.slug}  ${t.name}  ${t.role}${t.cliKeysNeedApproval ? '  (CLI keys need browser approval)' : ''}\n`);
  }
}

const TEAM_LIST_HELP = `Usage: erkle team list

List the teams you belong to. The session's active team is marked with *.

Options:
${COMMON_HELP}
${jsonHelp([
  ['activeTeam', '{id, name, slug, role, cliKeysNeedApproval}, or null'],
  ['teams', 'every team you belong to, in the same shape'],
])}
${envHelp(SESSION_ENV)}`;

async function runTeamList(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('team list', args, {});
  noPositionals('team list', positionals);
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const me = await fetchMe(api);
  printTeams(io, me);
  return { data: { activeTeam: me.activeTeam, teams: me.teams } };
}

export const teamList: Command = { name: 'team list', summary: 'list your teams', help: TEAM_LIST_HELP, run: runTeamList };

const TEAM_USE_HELP = `Usage: erkle team use <team>

Switch this session's active team. <team> is a team's id, slug, or exact
name. Keys you create and projects you list belong to the active team.

Options:
${COMMON_HELP}
${jsonHelp([
  ['activeTeam', 'the team now active: {id, name, slug, role, cliKeysNeedApproval}'],
  ['teams', 'every team you belong to, in the same shape'],
])}
${envHelp(SESSION_ENV)}`;

async function runTeamUse(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('team use', args, {});
  if (positionals.length !== 1) {
    throw new UsageError(positionals.length ? `unexpected argument: ${positionals.slice(1).join(' ')}` : 'team use needs a team', {
      hint: usageHint('team use'),
    });
  }
  const wanted = positionals[0]!;
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const me = await fetchMe(api);
  const byId = me.teams.filter((t) => t.id === wanted);
  const matches = byId.length ? byId : me.teams.filter((t) => t.slug === wanted || t.name === wanted);
  if (matches.length !== 1) {
    const why = matches.length ? `"${wanted}" matches more than one team; use its slug or id.` : `No team "${wanted}" among yours.`;
    const choices = me.teams.length ? ` Your teams: ${teamChoices(me.teams)}.` : ' You are not a member of any team yet.';
    throw new CliError('not_found', `${why}${choices}`, me.teams.length ? { hint: TEAM_HINT } : {});
  }
  const team = matches[0]!;
  const after = parseMe(await api.post('/api/cli/team', { teamId: team.id }), api.origin);
  const active = after.activeTeam ?? team;
  io.out(`✓ Active team: ${active.name} (${active.slug}, ${active.role}).\n`);
  return { data: { activeTeam: active, teams: after.teams } };
}

export const teamUse: Command = { name: 'team use', summary: "switch the session's active team", help: TEAM_USE_HELP, run: runTeamUse };

const PROJECTS_HELP = `Usage: erkle projects

List the projects you can read in the active team, by slug and name. Pass
slugs to \`erkle keys create --projects\`.

Options:
${COMMON_HELP}
${jsonHelp([['items', 'the projects: {id, slug, name}']])}
${envHelp(SESSION_ENV)}`;

async function runProjects(args: string[], { m, io }: Context): Promise<Outcome> {
  const { values: v, positionals } = parseCommand('projects', args, {});
  noPositionals('projects', positionals);
  const api = await connect(m, io.version, mcpUrl(v.url, m.env));
  const items = await fetchProjects(api);
  if (!items.length) io.out('No projects in the active team.\n');
  const width = Math.max(0, ...items.map((p) => p.slug.length)) + 2;
  for (const p of items) io.out(`${p.slug.padEnd(width)}${p.name}\n`);
  return { data: { items: items.map((p) => ({ id: p.id, slug: p.slug, name: p.name })) } };
}

export const projects: Command = { name: 'projects', summary: 'list projects in the active team', help: PROJECTS_HELP, run: runProjects };
