import { type FileChange, InitError, lineEnding, withEol } from './change.js';
import { type AgentEntry, type AuthMode, type EntryAuth, SERVER_NAME } from './text.js';

type Obj = Record<string, unknown>;

const SAFE_KEYS = new Set(['type', 'url', 'headers']);

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface JsonServerOptions {
  /** The fields init owns, `url` among them. */
  entry: Obj;
  auth: AuthMode;
  /** The Authorization value key mode writes, in this agent's env-variable syntax. */
  keyHeader: string;
  force: boolean;
  display: string;
}

/** The Authorization header's name in `headers`, matched case-insensitively. */
const authHeaderName = (headers: Obj) => Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');

/** Which auth a server entry's headers select: none, the Erkle-managed key header, or the user's own. */
export function headerAuth(headers: unknown, keyHeader: string): EntryAuth {
  if (headers === undefined) return 'oauth';
  if (!isObj(headers)) return 'custom';
  const name = authHeaderName(headers);
  if (name === undefined) return 'oauth';
  return headers[name] === keyHeader ? 'key' : 'custom';
}

/** The erkle entry in a JSON config's `mcpServers`, or null when there is none or the file can't be read. */
export function readJsonServer(text: string | null, keyHeader: string): AgentEntry | null {
  if (text === null || text.trim() === '') return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = isObj(root) && isObj(root.mcpServers) ? root.mcpServers[SERVER_NAME] : undefined;
  if (!isObj(entry)) return null;
  return { url: typeof entry.url === 'string' ? entry.url : null, auth: headerAuth(entry.headers, keyHeader) };
}

/**
 * `headers` as `auth` wants them: key mode sets Authorization to `keyHeader`;
 * OAuth drops it only when it is that Erkle-managed header, so a user's own
 * Authorization header stays. Every other header is the user's and is kept.
 */
export function headersFor(headers: unknown, auth: AuthMode, keyHeader: string): unknown {
  if (auth === 'oauth' && headerAuth(headers, keyHeader) !== 'key') return headers;
  const next: Obj = isObj(headers) ? { ...headers } : {};
  const name = authHeaderName(next);
  // Set in place so the header keeps its position and spelling.
  if (auth === 'key') next[name ?? 'Authorization'] = keyHeader;
  else if (name !== undefined) delete next[name];
  // An entry that never had headers, or only ours, shouldn't gain an empty object.
  if (Object.keys(next).length === 0 && (headers === undefined || name !== undefined)) return undefined;
  return next;
}

/** Whether an entry with `current` auth already matches `auth`: in OAuth mode, the user's own header counts as set up. */
export const authMatches = (current: EntryAuth, auth: AuthMode) => current === auth || (auth === 'oauth' && current === 'custom');

/**
 * Add or update `mcpServers.erkle` in a JSON config file, keeping every other
 * key. Fields the user added to an existing erkle entry (headers, say) are
 * kept; only the fields in `entry` and the Authorization header are set.
 */
export function planJsonServer(path: string, existing: string | null, o: JsonServerOptions): FileChange {
  const { entry, auth, keyHeader, force, display } = o;
  const withAuth = (base: Obj): Obj => {
    // Assigning in place keeps the key order, so an unchanged entry compares equal.
    const out = { ...base };
    const next = headersFor(base.headers, auth, keyHeader);
    if (next === undefined) delete out.headers;
    else out.headers = next;
    return out;
  };

  if (existing === null) {
    return {
      kind: 'file',
      path,
      action: 'create',
      summary: `add mcpServers.${SERVER_NAME}`,
      content: `${JSON.stringify({ mcpServers: { [SERVER_NAME]: withAuth(entry) } }, null, 2)}\n`,
    };
  }

  let root: unknown;
  try {
    root = existing.trim() === '' ? {} : JSON.parse(existing);
  } catch (err) {
    throw new InitError(
      `${display} is not valid JSON (${(err as Error).message}). ` +
        'It may contain comments or trailing commas. Fix it, or add the erkle server by hand.',
    );
  }
  if (!isObj(root)) throw new InitError(`${display} does not contain a JSON object.`);
  const servers = root.mcpServers ?? {};
  if (!isObj(servers)) throw new InitError(`${display}: "mcpServers" is not an object.`);

  const current = servers[SERVER_NAME];
  // A cloned repo may seed an erkle entry with keys that run code (command,
  // headersHelper, env...). Keep only keys known to be inert.
  const unknown = isObj(current) ? Object.keys(current).filter((k) => !SAFE_KEYS.has(k)) : [];
  if (unknown.length && !force) {
    return {
      kind: 'file',
      path,
      action: 'conflict',
      summary: `mcpServers.${SERVER_NAME} has unexpected keys (${unknown.join(', ')}); pass --force to replace`,
    };
  }
  const keep = isObj(current) ? Object.fromEntries(Object.entries(current).filter(([k]) => SAFE_KEYS.has(k))) : {};
  const merged = withAuth({ ...keep, ...entry });
  if (isObj(current) && JSON.stringify(merged) === JSON.stringify(current)) {
    return { kind: 'file', path, action: 'unchanged', summary: `mcpServers.${SERVER_NAME} already set` };
  }
  if (isObj(current) && current.url !== entry.url && !force) {
    return {
      kind: 'file',
      path,
      action: 'conflict',
      summary: `mcpServers.${SERVER_NAME} points to ${String(current.url)}; pass --force to replace`,
    };
  }
  // Only key mode replaces a user's own header; OAuth mode leaves it alone.
  if (auth === 'key' && isObj(current) && headerAuth(current.headers, keyHeader) === 'custom' && !force) {
    return {
      kind: 'file',
      path,
      action: 'conflict',
      summary: `mcpServers.${SERVER_NAME} has its own Authorization header; pass --force to replace`,
    };
  }

  const next = { ...root, mcpServers: { ...servers, [SERVER_NAME]: merged } };
  const eol = lineEnding(existing);
  const trailing = existing.endsWith('\n') ? eol : '';
  return {
    kind: 'file',
    path,
    action: 'update',
    summary: current === undefined ? `add mcpServers.${SERVER_NAME}` : `update mcpServers.${SERVER_NAME}`,
    content: withEol(JSON.stringify(next, null, detectIndent(existing)), eol) + trailing,
  };
}

function detectIndent(text: string): string | number {
  const m = /^([ \t]+)\S/m.exec(text);
  return m?.[1] ?? 2;
}
