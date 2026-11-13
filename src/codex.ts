import { appendSeparator, type FileChange, InitError, lineEnding, withEol } from './change.js';
import { type AgentEntry, API_KEY_ENV, type AuthMode, type EntryAuth, SERVER_NAME } from './text.js';

const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*("erkle"|'erkle'|erkle)[ \t]*\][ \t]*(#.*)?$/;
const ANY_TABLE = /^[ \t]*\[/;
const URL_LINE = /^([ \t]*url[ \t]*=[ \t]*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/;
const BEARER_LINE = /^([ \t]*bearer_token_env_var[ \t]*=[ \t]*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/;
const INLINE_OR_DOTTED_ERKLE = /(^|\n)[ \t]*(mcp_servers[ \t]*\.[ \t]*)?("erkle"|'erkle'|erkle)[ \t]*(\.[^=\n]*)?=/;
// `mcp_servers = { ... }` can't be extended by a later [mcp_servers.erkle] table.
const INLINE_SERVERS = /^[ \t]*("mcp_servers"|'mcp_servers'|mcp_servers)[ \t]*=/;
// Any other header naming erkle under mcp_servers (quoted keys, a lone subtable).
const OTHER_ERKLE_HEADER = /^[ \t]*\[[^\]]*mcp_servers[^\]]*erkle/;

/** A line without its trailing CR, for matching in CRLF files. */
const bare = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** The `[mcp_servers.erkle]` table in a config.toml, located line by line. */
interface Table {
  start: number;
  end: number;
  urlIdx: number;
  urlMatch: RegExpExecArray | null;
  bearerIdx: number;
  bearerMatch: RegExpExecArray | null;
}

function findTable(bareLines: string[]): Table | null {
  const start = bareLines.findIndex((l) => HEADER.test(l));
  if (start === -1) return null;
  let end = bareLines.findIndex((l, i) => i > start && ANY_TABLE.test(l));
  if (end === -1) end = bareLines.length;
  const t: Table = { start, end, urlIdx: -1, urlMatch: null, bearerIdx: -1, bearerMatch: null };
  for (let i = start + 1; i < end; i++) {
    const line = bareLines[i]!;
    if (!t.urlMatch) {
      t.urlMatch = URL_LINE.exec(line);
      if (t.urlMatch) t.urlIdx = i;
    }
    if (!t.bearerMatch) {
      t.bearerMatch = BEARER_LINE.exec(line);
      if (t.bearerMatch) t.bearerIdx = i;
    }
  }
  return t;
}

function bearerAuth(t: Table): EntryAuth {
  if (!t.bearerMatch) return 'oauth';
  return parseTomlString(t.bearerMatch[2]!) === API_KEY_ENV ? 'key' : 'custom';
}

/** The erkle entry in a Codex config.toml, or null when it has none in a form this tool reads. */
export function readCodex(text: string | null): AgentEntry | null {
  if (text === null) return null;
  const t = findTable(text.split('\n').map(bare));
  if (!t) return null;
  return { url: t.urlMatch ? parseTomlString(t.urlMatch[2]!) : null, auth: bearerAuth(t) };
}

export interface CodexOptions {
  url: string;
  auth: AuthMode;
  force: boolean;
  display: string;
}

/**
 * Add `[mcp_servers.erkle]` to a Codex config.toml as text. The file is never
 * re-serialized, so comments and formatting survive byte for byte. Key mode
 * names the environment variable Codex reads the bearer token from.
 */
export function planCodex(path: string, existing: string | null, o: CodexOptions): FileChange {
  const { url, auth, force, display } = o;
  const bearerLine = `bearer_token_env_var = ${JSON.stringify(API_KEY_ENV)}`;
  const table = `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\n${auth === 'key' ? `${bearerLine}\n` : ''}`;
  if (existing === null) {
    return { kind: 'file', path, action: 'create', summary: 'add [mcp_servers.erkle]', content: table };
  }

  const eol = lineEnding(existing);
  const lines = existing.split('\n');
  const bareLines = lines.map(bare);
  const t = findTable(bareLines);
  if (!t) {
    if (bareLines.some((l) => OTHER_ERKLE_HEADER.test(l)) || INLINE_OR_DOTTED_ERKLE.test(mcpServersTableBody(bareLines))) {
      throw new InitError(`${display} defines the erkle server in a form this tool doesn't edit. Set its url by hand.`);
    }
    if (topLevel(bareLines).some((l) => INLINE_SERVERS.test(l))) {
      throw new InitError(
        `${display} declares mcp_servers as an inline table, which can't be extended. Add erkle to it by hand.`,
      );
    }
    return {
      kind: 'file',
      path,
      action: 'update',
      summary: 'add [mcp_servers.erkle]',
      content: existing + appendSeparator(existing, eol) + withEol(table, eol),
    };
  }

  const current = t.urlMatch ? parseTomlString(t.urlMatch[2]!) : null;
  const currentAuth = bearerAuth(t);
  // OAuth mode removes only the Erkle-managed bearer_token_env_var; the user's own stays.
  const wantAuth: EntryAuth = auth === 'oauth' && currentAuth === 'custom' ? 'custom' : auth;
  if (current === url && currentAuth === wantAuth) {
    return { kind: 'file', path, action: 'unchanged', summary: '[mcp_servers.erkle] already set' };
  }
  if (current !== url && !force) {
    const what = current === null ? 'has no url' : `points to ${current}`;
    return { kind: 'file', path, action: 'conflict', summary: `[mcp_servers.erkle] ${what}; pass --force to replace` };
  }
  if (auth === 'key' && currentAuth === 'custom' && !force) {
    const name = parseTomlString(t.bearerMatch![2]!);
    return {
      kind: 'file',
      path,
      action: 'conflict',
      summary: `[mcp_servers.erkle] reads its token from ${name}; pass --force to replace`,
    };
  }

  const next = [...lines];
  const cr = eol === '\r\n' ? '\r' : '';
  const keepCr = (i: number) => (lines[i]!.endsWith('\r') ? '\r' : '');
  const did: string[] = [];
  // The token line is edited first; `urlLine` tracks where the url line ends up.
  let urlLine = t.urlIdx;
  if (currentAuth !== wantAuth) {
    if (auth === 'key' && t.bearerMatch) {
      const [, prefix, , rest] = t.bearerMatch;
      next[t.bearerIdx] = `${prefix}${JSON.stringify(API_KEY_ENV)}${rest}${keepCr(t.bearerIdx)}`;
    } else if (auth === 'key') {
      // Right after the url line, or at the top of the table when there is none yet.
      next.splice((t.urlIdx === -1 ? t.start : t.urlIdx) + 1, 0, `${bearerLine}${cr}`);
    } else {
      next.splice(t.bearerIdx, 1);
      if (t.bearerIdx < urlLine) urlLine--;
    }
    did.push(auth === 'key' ? 'set bearer_token_env_var' : 'remove bearer_token_env_var');
  }
  if (current !== url) {
    if (t.urlMatch) {
      const [, prefix, , rest] = t.urlMatch;
      next[urlLine] = `${prefix}${JSON.stringify(url)}${rest}${keepCr(t.urlIdx)}`;
    } else {
      next.splice(t.start + 1, 0, `url = ${JSON.stringify(url)}${cr}`);
    }
    did.unshift('url');
  }
  return { kind: 'file', path, action: 'update', summary: `update [mcp_servers.erkle] ${did.join(', ')}`, content: next.join('\n') };
}

/** Lines before the first table header. */
function topLevel(lines: string[]): string[] {
  const end = lines.findIndex((l) => ANY_TABLE.test(l));
  return end === -1 ? lines : lines.slice(0, end);
}

/** Only the `[mcp_servers]` table, where `erkle = {...}` would live. */
function mcpServersTableBody(lines: string[]): string {
  const out: string[] = [];
  let inServers = false;
  let top = true;
  for (const line of lines) {
    if (ANY_TABLE.test(line)) {
      top = false;
      inServers = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\][ \t]*(#.*)?$/.test(line);
      continue;
    }
    if (inServers) out.push(line);
    else if (top && /^[ \t]*mcp_servers[ \t]*\./.test(line)) out.push(line);
  }
  return out.join('\n');
}

function parseTomlString(raw: string): string {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}
