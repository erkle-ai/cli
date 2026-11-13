import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CliError, UsageError } from './output.js';
import type { Machine } from './probe.js';
import { DEFAULT_URL } from './text.js';

/**
 * Where the CLI keeps sign-ins and pending approvals. One 0600 JSON file holds
 * a session per server origin; the CLI only ever uses the entry for the origin
 * it is talking to, so a repo's `.env` pointing ERKLE_URL elsewhere never gets
 * the erkle.ai session.
 */

export const DEFAULT_ORIGIN = new URL(DEFAULT_URL).origin;

/** A stored sign-in. Fields other than `token` are kept as written. */
export interface StoredSession {
  token: string;
  [key: string]: unknown;
}

export type PendingKind = 'login' | 'key';

/** A browser approval the CLI is still waiting on, saved so `--resume` can collect it. */
export interface PendingRequest {
  id: string;
  kind: string;
  origin: string;
  expiresAt: string;
  [key: string]: unknown;
}

export interface Credential {
  token: string;
  source: 'env' | 'file';
}

interface CredentialsFile {
  schemaVersion: 1;
  sessions: Record<string, StoredSession>;
}

const CONFIG_HINT = 'Set ERKLE_CONFIG_DIR to a private directory outside any repository.';

/** First of $ERKLE_CONFIG_DIR, $XDG_CONFIG_HOME/erkle, %APPDATA%\erkle on Windows, ~/.config/erkle. */
export function configDir(m: Machine, platform: NodeJS.Platform = process.platform): string {
  const set = (v: string | undefined) => v || undefined;
  const own = set(m.env.ERKLE_CONFIG_DIR);
  if (own) return resolve(m.cwd, own);
  const xdg = set(m.env.XDG_CONFIG_HOME);
  // The XDG spec says to ignore a relative value.
  if (xdg && isAbsolute(xdg)) return join(xdg, 'erkle');
  const appData = set(m.env.APPDATA);
  if (platform === 'win32' && appData) return join(appData, 'erkle');
  return join(m.home, '.config', 'erkle');
}

const verifiedDirs = new WeakMap<Machine, string>();

/**
 * The config directory, checked: not inside a git work tree, and not a
 * symlink. The check runs once per Machine and directory; files inside are
 * still checked on every read and write.
 */
function safeConfigDir(m: Machine): string {
  const dir = configDir(m);
  if (verifiedDirs.get(m) === dir) return dir;
  // Ask git from the nearest directory that exists; run from home like probe().
  let probeDir = dir;
  while (!existsSync(probeDir) && dirname(probeDir) !== probeDir) probeDir = dirname(probeDir);
  const r = m.exec('git', ['-C', probeDir, 'rev-parse', '--is-inside-work-tree'], m.home);
  if (r.ok && r.stdout.trim() === 'true') {
    throw new CliError('file_unsafe', `Refusing to keep credentials in ${dir}: it is inside a git work tree, where they could be committed.`, {
      hint: CONFIG_HINT,
    });
  }
  checkNotLink(dir);
  verifiedDirs.set(m, dir);
  return dir;
}

/** Refuse a symlink (it could send a write anywhere) or something that isn't the expected kind. */
function checkNotLink(path: string, kind: 'dir' | 'file' = 'dir'): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw unsafe(path, (err as Error).message);
  }
  if (st.isSymbolicLink()) throw unsafe(path, 'it is a symlink');
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw unsafe(path, `it is not a ${kind === 'dir' ? 'directory' : 'regular file'}`);
}

function unsafe(path: string, why: string): CliError {
  return new CliError('file_unsafe', `Refusing to use ${path}: ${why}.`, { hint: CONFIG_HINT });
}

function readJson(path: string): unknown {
  checkNotLink(path, 'file');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unsafe(path, (err as Error).message);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw unsafe(path, 'it is not valid JSON; fix or delete it');
  }
}

/**
 * Writes `text` to a fresh 0600 file at `tmp`, then renames it over `path`.
 * On failure the temp file is removed and the error rethrown for the caller
 * to word.
 */
export function writePrivateFile(path: string, tmp: string, text: string): void {
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  checkNotLink(dir);
  checkNotLink(path, 'file');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(path, join(dir, `.${randomBytes(6).toString('hex')}.erkle.tmp`), `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    throw unsafe(path, (err as Error).message);
  }
}

const credentialsPath = (dir: string) => join(dir, 'credentials.json');

function readFile(m: Machine): { path: string; data: CredentialsFile } {
  const path = credentialsPath(safeConfigDir(m));
  const raw = readJson(path) as Partial<CredentialsFile> | undefined;
  const sessions = raw && typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {};
  return { path, data: { schemaVersion: 1, sessions } };
}

export function readSession(m: Machine, origin: string): StoredSession | null {
  const s = readFile(m).data.sessions[origin];
  return s && typeof s.token === 'string' ? s : null;
}

export function saveSession(m: Machine, origin: string, session: StoredSession): void {
  const { path, data } = readFile(m);
  data.sessions[origin] = session;
  writeJson(path, data);
}

/** Forget the session for `origin`; returns what was stored. */
export function removeSession(m: Machine, origin: string): StoredSession | null {
  const { path, data } = readFile(m);
  const old = data.sessions[origin];
  if (old === undefined) return null;
  delete data.sessions[origin];
  writeJson(path, data);
  return typeof old.token === 'string' ? old : null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A bearer may go over https, or over plain http only to this machine. */
export function bearerAllowed(origin: string): boolean {
  const u = new URL(origin);
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
}

export function assertBearerAllowed(origin: string): void {
  if (!bearerAllowed(origin)) {
    throw new UsageError(
      `Refusing to send credentials to ${origin} over plain http. Use https, or http only to localhost, 127.0.0.1 or ::1.`,
      { hint: 'Point --url or ERKLE_URL at an https server.' },
    );
  }
}

/** Why a bearer from the environment may not go to an origin: plain http to another machine, or a server nobody named. */
export type BearerRefusal = 'insecure' | 'not_named';

/**
 * The one rule for where `ERKLE_TOKEN` and `ERKLE_API_KEY` may be sent:
 * https://erkle.ai always, plus the origin named in `ERKLE_TOKEN_ORIGIN`,
 * and only over https (or http to this machine). Null when `origin` is
 * allowed. Throws a usage error when ERKLE_TOKEN_ORIGIN is not a URL.
 */
export function bearerOriginRefusal(m: Machine, origin: string): BearerRefusal | null {
  const named = tokenOrigin(m);
  if (origin !== DEFAULT_ORIGIN && origin !== named) return 'not_named';
  return bearerAllowed(origin) ? null : 'insecure';
}

/** The one origin besides erkle.ai that ERKLE_TOKEN and ERKLE_API_KEY may go to: ERKLE_TOKEN_ORIGIN, else the default. */
export function tokenOrigin(m: Machine): string {
  const value = m.env.ERKLE_TOKEN_ORIGIN;
  if (!value) return DEFAULT_ORIGIN;
  try {
    return new URL(value).origin;
  } catch {
    throw new UsageError(`ERKLE_TOKEN_ORIGIN must be a URL like https://erkle.ai, got ${value}`);
  }
}

/**
 * The credential to send to `origin`. `ERKLE_TOKEN` overrides the stored
 * session, but only where `bearerOriginRefusal` allows:
 * a CI config or `.env` that also sets ERKLE_URL must not hand the token to
 * another server. With ERKLE_TOKEN set for a different origin and no session
 * stored for this one, that is a usage error naming the rule.
 */
export function resolveCredential(m: Machine, origin: string): Credential | null {
  const env = m.env.ERKLE_TOKEN;
  const refusal = env ? bearerOriginRefusal(m, origin) : null;
  if (refusal === 'insecure') assertBearerAllowed(origin);
  if (env && refusal === null) return { token: env, source: 'env' };
  const stored = readSession(m, origin);
  if (stored) return { token: stored.token, source: 'file' };
  if (env) {
    throw new UsageError(
      `ERKLE_TOKEN is only sent to ${DEFAULT_ORIGIN}, or to the origin in ERKLE_TOKEN_ORIGIN; this command talks to ${origin}.`,
      { hint: `Set ERKLE_TOKEN_ORIGIN=${origin} if that server is yours, or unset ERKLE_URL.` },
    );
  }
  return null;
}

// Request ids come from the server; they name a file, so nothing that could walk the path.
const PENDING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function pendingDir(m: Machine): string {
  const dir = join(safeConfigDir(m), 'pending');
  checkNotLink(dir);
  return dir;
}

function pendingPath(m: Machine, id: string): string {
  if (!PENDING_ID.test(id)) throw new UsageError(`not a request id: ${id}`);
  return join(pendingDir(m), `${id}.json`);
}

const asPending = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as PendingRequest) : null);

export function savePending(m: Machine, p: PendingRequest): void {
  writeJson(pendingPath(m, p.id), p);
}

export function readPending(m: Machine, id: string): PendingRequest | null {
  return asPending(readJson(pendingPath(m, id)));
}

/** Saved requests of one kind for one server, for `--resume` without an id. Unreadable files are skipped. */
export function listPending(m: Machine, kind: PendingKind, origin: string): PendingRequest[] {
  const dir = pendingDir(m);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw unsafe(dir, (err as Error).message);
  }
  const found: PendingRequest[] = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!PENDING_ID.test(id)) continue;
    let p: PendingRequest | null;
    try {
      p = asPending(readJson(join(dir, name)));
    } catch {
      continue;
    }
    if (p && p.kind === kind && p.origin === origin) found.push(p);
  }
  return found;
}

/** Remove a pending request once it is collected, denied, or expired. Missing is fine. */
export function deletePending(m: Machine, id: string): void {
  const path = pendingPath(m, id);
  checkNotLink(path, 'file');
  rmSync(path, { force: true });
}
