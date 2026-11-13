import { type Context, usageHint } from './commands/command.js';
import { deletePending, type PendingKind, type PendingRequest, readPending, savePending } from './credentials.js';
import { type Api, HttpError, REQUEST_TIMEOUT_MS } from './http.js';
import { CliError, UsageError } from './output.js';

/**
 * Waiting on a browser approval, shared by `login` and approval-required
 * `keys create`. The server hands out a device secret and a code; the person
 * approves in a browser on any device; the CLI polls until it is approved,
 * denied, or expired.
 *
 * With a terminal the CLI waits until the request expires. Without one it
 * waits at most `DEFAULT_WAIT_SECONDS` (or `--timeout`), so an agent's shell
 * timeout never cuts it off, and returns `pending` with a `--resume` command.
 */

export const DEFAULT_WAIT_SECONDS = 90;
/** Added to the poll interval each time a poll is rate limited or fails. */
const BACKOFF_MS = 5000;
/** Network errors and 5xx answers in a row before the wait gives up. */
const MAX_POLL_FAILURES = 3;
const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 60;

/** What the server returns when it opens a login or key request. */
export interface DeviceRequest {
  deviceSecret: string;
  userCode: string;
  approvalUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

/** A device request saved under `pending/<id>.json` so `--resume` can collect it. */
export type PendingApproval = PendingRequest & DeviceRequest;

/** Options a waiting command accepts; spread into its `parseCommand` options. */
export const WAIT_OPTIONS = {
  'no-wait': { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false },
  timeout: { type: 'string' },
} as const;

export const WAIT_HELP = `  --no-wait           print the approval link and return at once with a resume command
  --resume [<id>]     collect a request started earlier
  --timeout <s>       stop waiting after this many seconds (default: until the request
                      expires on a terminal, ${DEFAULT_WAIT_SECONDS} seconds otherwise)
`;

export interface WaitFlags {
  noWait: boolean;
  resume: boolean;
  resumeId: string | null;
  timeoutSeconds: number | null;
}

/** Reads `--no-wait`, `--resume [<id>]` and `--timeout` from a parse with `WAIT_OPTIONS`. */
export function waitFlags(
  name: string,
  values: { 'no-wait'?: boolean; resume?: boolean; timeout?: string },
  positionals: string[],
): WaitFlags {
  const hint = usageHint(name);
  const noWait = values['no-wait'] === true;
  const resume = values.resume === true;
  if (noWait && resume) throw new UsageError('--no-wait and --resume cannot be used together', { hint });
  if (positionals.length > (resume ? 1 : 0)) throw new UsageError(`unexpected argument: ${positionals.join(' ')}`, { hint });
  let timeoutSeconds: number | null = null;
  if (values.timeout !== undefined) {
    timeoutSeconds = /^\d+$/.test(values.timeout) ? Number(values.timeout) : NaN;
    if (!(timeoutSeconds > 0)) throw new UsageError(`--timeout takes a whole number of seconds, got ${values.timeout}`, { hint });
  }
  return { noWait, resume, resumeId: resume ? (positionals[0] ?? null) : null, timeoutSeconds };
}

/**
 * Checks a request the server just opened. The approval link must be on the
 * origin the CLI called: otherwise a server set as ERKLE_URL could relay a
 * genuine request from another server and collect what it grants.
 */
export function parseDeviceRequest(raw: unknown, origin: string): DeviceRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bad = () => new CliError('server', `${origin} answered with a request the CLI does not understand.`, { hint: 'Check --url, then try again.' });
  if (typeof r.deviceSecret !== 'string' || !r.deviceSecret) throw bad();
  if (typeof r.userCode !== 'string' || !r.userCode) throw bad();
  if (typeof r.expiresAt !== 'string' || Number.isNaN(Date.parse(r.expiresAt))) throw bad();
  if (typeof r.approvalUrl !== 'string') throw bad();
  let linkOrigin: string;
  try {
    linkOrigin = new URL(r.approvalUrl).origin;
  } catch {
    throw bad();
  }
  if (linkOrigin !== origin) {
    throw new CliError('server', `${origin} sent an approval link on ${linkOrigin}; refusing it, since approving there would sign in somewhere else.`, {
      hint: 'Check --url and ERKLE_URL point at the Erkle server you mean.',
    });
  }
  const interval = typeof r.pollIntervalSeconds === 'number' && Number.isFinite(r.pollIntervalSeconds) ? r.pollIntervalSeconds : DEFAULT_INTERVAL_S;
  return {
    deviceSecret: r.deviceSecret,
    userCode: r.userCode,
    approvalUrl: r.approvalUrl,
    expiresAt: r.expiresAt,
    pollIntervalSeconds: Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, interval)),
  };
}

/** A browser can open: on a terminal, outside SSH and CI, and on Linux with a display. */
export function browserAvailable(env: Record<string, string | undefined>, interactive: boolean, platform: NodeJS.Platform = process.platform): boolean {
  if (!interactive) return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (env.CI) return false;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/** A saved request for `--resume`, checked against the kind and server the command expects. */
export function loadPending(ctx: Context, id: string, kind: PendingKind, origin: string, restart: string): PendingApproval {
  const p = readPending(ctx.m, id) as Partial<PendingApproval> | null;
  if (!p || p.kind !== kind || typeof p.deviceSecret !== 'string' || typeof p.userCode !== 'string' || typeof p.approvalUrl !== 'string') {
    throw new CliError('not_found', `No pending ${kind} request${id ? ` ${id}` : ''} to resume.`, { hint: restart });
  }
  if (p.origin !== origin) {
    throw new UsageError(`That request is for ${p.origin}, not ${origin}.`, { hint: `Add \`--url ${p.origin}/mcp\` to resume it.` });
  }
  return p as PendingApproval;
}

export interface Approval<T> {
  ctx: Context;
  /** Unauthenticated client for the server that opened the request. */
  api: Api;
  /** The public poll route, for example `/api/cli/login-requests/poll`. */
  pollPath: string;
  request: PendingApproval;
  /** True when this run picked up a saved request with `--resume`. */
  resumed: boolean;
  flags: WaitFlags;
  /** What is being approved, for messages: "sign-in", "key request". */
  label: string;
  /** The command that collects this request later, for example `erkle login --resume`. */
  resumeCommand: string;
  /** Hint for denied or expired, for example "Run `erkle login` again." */
  restartHint: string;
  /** Called once with the approved poll reply; its result is returned. */
  onApproved(reply: Record<string, unknown>): Promise<T>;
}

export type ApprovalResult<T> = { status: 'approved'; value: T } | { status: 'pending'; data: PendingData };

/** The fields a `pending` result carries; the command adds its own. */
export interface PendingData {
  status: 'pending';
  approvalUrl: string;
  userCode: string;
  expiresAt: string;
  resume: string;
}

/**
 * Prints the link and code, saves the request so it can be resumed, opens a
 * browser when one is available, then polls per the rules above. Throws
 * `denied` or `expired`; the pending file is gone after either, or after the
 * approval is collected.
 */
export async function awaitApproval<T>(a: Approval<T>): Promise<ApprovalResult<T>> {
  const { ctx, request: req, flags } = a;
  const { m, io } = ctx;

  if (!a.resumed) savePending(m, req);
  io.out(
    `${a.resumed ? `Still waiting on the ${a.label}.` : `To approve the ${a.label}, open:`}\n  ${req.approvalUrl}\nand enter the code: ${req.userCode}\n`,
  );
  if (!a.resumed && browserAvailable(m.env, io.interactive)) await m.openBrowser(req.approvalUrl).catch(() => false);

  const pendingResult = (): ApprovalResult<T> => {
    io.out(`Not approved yet. Once it is, run \`${a.resumeCommand}\`.\n`);
    return {
      status: 'pending',
      data: { status: 'pending', approvalUrl: req.approvalUrl, userCode: req.userCode, expiresAt: req.expiresAt, resume: a.resumeCommand },
    };
  };
  const expired = () => {
    deletePending(m, req.id);
    return new CliError('expired', `The ${a.label} expired before it was approved.`, { hint: a.restartHint });
  };

  if (flags.noWait) return pendingResult();

  const expiresMs = Date.parse(req.expiresAt);
  if (m.now() >= expiresMs) throw expired();
  const ceilingS = flags.timeoutSeconds ?? (io.interactive ? null : DEFAULT_WAIT_SECONDS);
  const deadline = ceilingS === null ? expiresMs : Math.min(expiresMs, m.now() + ceilingS * 1000);
  let interval = req.pollIntervalSeconds * 1000;
  // A resumed request may already be approved: ask before sleeping.
  let sleepFirst = !a.resumed;
  let failures = 0;

  while (true) {
    if (sleepFirst) {
      if (m.now() + interval > deadline) break;
      await m.sleep(interval);
    }
    sleepFirst = true;
    let reply: Record<string, unknown>;
    try {
      // A stalled poll must not carry the wait past its deadline.
      const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - m.now()));
      reply = (await a.api.post<Record<string, unknown>>(a.pollPath, { deviceSecret: req.deviceSecret }, timeoutMs)) ?? {};
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        interval += BACKOFF_MS;
        continue;
      }
      // A network error or 5xx may pass; the request is still on the server, so keep it.
      if (err instanceof HttpError && (err.status === null || err.status >= 500)) {
        if (++failures < MAX_POLL_FAILURES) {
          interval += BACKOFF_MS;
          continue;
        }
        throw new HttpError(err.code, err.message, err.status, {
          hint: `Run \`${a.resumeCommand}\` to keep waiting on the same request.`,
          ...(err.reason !== undefined ? { reason: err.reason } : {}),
        });
      }
      throw err;
    }
    failures = 0;
    if (reply.status === 'approved') {
      deletePending(m, req.id);
      return { status: 'approved', value: await a.onApproved(reply) };
    }
    if (reply.status === 'denied') {
      deletePending(m, req.id);
      if (reply.reason === 'session_ended') {
        throw new CliError('session_revoked', `The sign-in that opened this ${a.label} ended before it was collected.`, {
          hint: 'Run `erkle login`, then run the same command again.',
          reason: 'session_ended',
        });
      }
      throw new CliError('denied', `The ${a.label} was denied.`, { hint: a.restartHint });
    }
    if (reply.status === 'expired') throw expired();
    if (reply.status !== 'pending') {
      throw new CliError('server', `${a.api.origin} answered the poll with an unknown status.`, { hint: `Run \`${a.resumeCommand}\` to try again.` });
    }
  }
  if (deadline >= expiresMs) throw expired();
  return pendingResult();
}
