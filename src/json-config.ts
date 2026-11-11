import { type FileChange, InitError, lineEnding, withEol } from './change.js';
import { SERVER_NAME } from './text.js';

type Obj = Record<string, unknown>;

const SAFE_KEYS = new Set(['type', 'url', 'headers']);

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Add or update `mcpServers.erkle` in a JSON config file, keeping every other
 * key. Fields the user added to an existing erkle entry (headers, say) are
 * kept; only the fields in `entry` are set.
 */
export function planJsonServer(
  path: string,
  existing: string | null,
  entry: Obj,
  force: boolean,
  display: string,
): FileChange {
  if (existing === null) {
    return {
      kind: 'file',
      path,
      action: 'create',
      summary: `add mcpServers.${SERVER_NAME}`,
      content: `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n`,
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
  const merged = { ...keep, ...entry };
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
