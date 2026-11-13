import { assertBearerAllowed, bearerAllowed, resolveCredential } from './credentials.js';
import { CliError, type ErrorCode, isErrorCode, UsageError } from './output.js';
import type { Machine } from './probe.js';
import { DEFAULT_URL } from './text.js';

/** `--url`, then `$ERKLE_URL`, then the default. The value is the MCP URL, used as given. */
export function mcpUrl(flag: string | undefined, env: Record<string, string | undefined>): string {
  const url = flag ?? env.ERKLE_URL ?? DEFAULT_URL;
  if (!/^https?:\/\/[^/\s]+/.test(url)) throw new UsageError(`--url must be an http(s) URL, got ${url}`);
  return url;
}

/** The server's REST API lives on the same origin as its MCP endpoint. */
export function apiOrigin(mcp: string): string {
  try {
    return new URL(mcp).origin;
  } catch {
    throw new UsageError(`--url must be an http(s) URL, got ${mcp}`);
  }
}

export { assertBearerAllowed, bearerAllowed };

export const userAgent = (version: string) => `erkle-cli/${version} (${process.platform})`;

/** A failed request, with the HTTP status when the server answered. */
export class HttpError extends CliError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly status: number | null,
    opts: { hint?: string; reason?: string } = {},
  ) {
    super(code, message, opts);
  }
}

export const LOGIN_HINT = 'Run `erkle login`.';
export const TEAM_HINT = 'Run `erkle team use <team>`.';

export const serverReplyError = (origin: string, what: string) =>
  new CliError('server', `${origin} answered ${what} with something unexpected.`, { hint: 'Run the same command again in a minute.' });

/** How long one request may take before the CLI gives up on it. */
export const REQUEST_TIMEOUT_MS = 30_000;

export function networkError(origin: string, err: unknown): HttpError {
  if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
    return new HttpError('network', `${origin} did not answer in time.`, null, {
      hint: 'Check your connection and --url, then run the same command again.',
    });
  }
  const cause = (err as { cause?: { message?: string } }).cause?.message;
  return new HttpError('network', `Couldn't reach ${origin}: ${cause ?? (err as Error).message}`, null, {
    hint: 'Check your connection and --url, then run the same command again.',
  });
}

/**
 * JSON over fetch to one Erkle origin. Sends `User-Agent: erkle-cli/<version>`,
 * never an Origin header (the server's origin guard rejects foreign origins),
 * and never follows a redirect, so a bearer cannot be bounced elsewhere.
 */
export class Api {
  constructor(
    private readonly m: Machine,
    private readonly version: string,
    readonly origin: string,
    private readonly token: string | null,
  ) {
    if (token !== null) assertBearerAllowed(origin);
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** `timeoutMs` shortens the request's timeout below the default. */
  post<T = unknown>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>('POST', path, body, timeoutMs);
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { 'user-agent': userAgent(this.version), accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers, redirect: 'manual' };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.m.fetch(`${this.origin}${path}`, init, timeoutMs);
    } catch (err) {
      throw networkError(this.origin, err);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // The timeout also covers reading the body; a cut-off body is not an empty one.
      throw networkError(this.origin, err);
    }
    let parsed: unknown = null;
    let isJson = false;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        // Handled below: a proxy error page, or not an Erkle server.
      }
    }
    if (res.status >= 200 && res.status < 300) {
      if (text !== '' && !isJson) throw new HttpError('server', `${this.origin} answered ${method} ${path} with something other than JSON.`, res.status);
      return parsed as T;
    }
    throw failureFor(res, parsed, this.origin);
  }
}

/** Maps a non-2xx response to an error code. The server's `details.reason` wins when it names one. */
function failureFor(res: Response, body: unknown, origin: string): HttpError {
  const error = (body as { error?: { message?: unknown; details?: { reason?: unknown } } } | null)?.error;
  const serverMessage = typeof error?.message === 'string' ? error.message : null;
  const reason = error?.details?.reason;
  const status = res.status;
  const message = (fallback: string) => serverMessage ?? fallback;

  if (reason === 'no_active_team' || reason === 'no_team') {
    return new HttpError('no_team', message('No active team.'), status, { hint: TEAM_HINT });
  }
  if (status === 401) {
    const code = reason === 'session_expired' || reason === 'session_revoked' ? reason : 'not_signed_in';
    return new HttpError(code, message('Not signed in.'), status, { hint: LOGIN_HINT });
  }
  if (isErrorCode(reason) && reason !== 'usage') return new HttpError(reason, message(reason), status);
  if (status === 429) {
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? `Wait ${Math.ceil(after)} seconds` : 'Wait a minute';
    return new HttpError('rate_limited', message('Too many requests.'), status, { hint: `${wait}, then run the same command again.` });
  }
  if (status === 403) return new HttpError('forbidden', message('Not allowed.'), status);
  if (status === 404) return new HttpError('not_found', message('Not found.'), status);
  if (status === 409) return new HttpError('conflict', message('Conflict.'), status);
  if (status >= 300 && status < 400) return new HttpError('server', `${origin} answered with a redirect (${status}); not following it.`, status);
  return new HttpError('server', `${origin} answered ${status}${serverMessage ? `: ${serverMessage}` : '.'}`, status, {
    hint: 'Run the same command again in a minute.',
  });
}

/**
 * An `Api` carrying the credential for the server behind `mcp`: `ERKLE_TOKEN`
 * where it applies, else this origin's stored session. Fails with
 * `not_signed_in` when there is neither.
 */
export async function connect(m: Machine, version: string, mcp: string): Promise<Api> {
  const origin = apiOrigin(mcp);
  const cred = resolveCredential(m, origin);
  if (!cred) throw new CliError('not_signed_in', `Not signed in to ${origin}.`, { hint: LOGIN_HINT });
  return new Api(m, version, origin, cred.token);
}
