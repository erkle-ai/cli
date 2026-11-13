/**
 * The output contract every command shares.
 *
 * With `--json`, stdout gets exactly one document:
 *   { "ok": true,  "schemaVersion": 1, "command": "keys create", ... }
 *   { "ok": false, "schemaVersion": 1, "error": { "code", "message", "hint" } }
 * and human progress text goes to stderr. Without it, human text goes to
 * stdout as before. Either way nothing raw from a config file or a server
 * reaches the terminal.
 */

export const SCHEMA_VERSION = 1;

/** Every error code a command can report. Agents branch on these; keep the set closed. */
export const ERROR_CODES = [
  'usage',
  'not_signed_in',
  'session_expired',
  'session_revoked',
  'no_team',
  'forbidden',
  'not_found',
  'approval_required',
  'denied',
  'expired',
  'key_rejected',
  'rate_limited',
  'network',
  'server',
  'conflict',
  'file_unsafe',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const isErrorCode = (s: unknown): s is ErrorCode => typeof s === 'string' && (ERROR_CODES as readonly string[]).includes(s);

/** Exit 2 for a usage error, 1 for any other error. Success, including a pending result, is 0. */
export function exitCodeFor(code: ErrorCode): 1 | 2 {
  return code === 'usage' ? 2 : 1;
}

export interface ErrorOptions {
  /** The next thing to run, for example "Run `erkle login`." */
  hint?: string;
  /** A finer cause within the code, for example why a key was rejected. */
  reason?: string;
  /** Extra fields for the `--json` error document, for a command that reports more than one failure. */
  data?: Record<string, unknown>;
}

/** An error with a code from the closed set; `run()` turns it into output and an exit code. */
export class CliError extends Error {
  readonly hint: string | undefined;
  readonly reason: string | undefined;
  readonly data: Record<string, unknown> | undefined;

  constructor(
    readonly code: ErrorCode,
    message: string,
    opts: ErrorOptions = {},
  ) {
    super(message);
    this.hint = opts.hint;
    this.reason = opts.reason;
    this.data = opts.data;
  }
}

export class UsageError extends CliError {
  constructor(message: string, opts: ErrorOptions = {}) {
    super('usage', message, opts);
  }
}

export interface Failure {
  code: ErrorCode;
  message: string;
  hint: string | null;
  reason?: string;
}

export function successDocument(command: string, data: Record<string, unknown> = {}): string {
  return jsonDocument({ ok: true, schemaVersion: SCHEMA_VERSION, command, ...data });
}

export function errorDocument(f: Failure, data: Record<string, unknown> = {}): string {
  const error: Record<string, unknown> = { code: f.code, message: f.message, hint: f.hint };
  if (f.reason !== undefined) error.reason = f.reason;
  return jsonDocument({ ...data, ok: false, schemaVersion: SCHEMA_VERSION, error });
}

/**
 * One line of JSON. JSON.stringify leaves DEL and the C1 controls raw, and a
 * terminal acts on those, so they are escaped too; the data is unchanged.
 */
export function jsonDocument(value: unknown): string {
  const text = JSON.stringify(value).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${text}\n`;
}

// Config files come from cloned repos and names come from the server; never
// let their bytes drive the terminal.
export const printable = (t: string) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
