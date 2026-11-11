import { appendSeparator, type FileChange, InitError, lineEnding, withEol } from './change.js';
import { SERVER_NAME } from './text.js';

const HEADER = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*("erkle"|'erkle'|erkle)[ \t]*\][ \t]*(#.*)?$/;
const ANY_TABLE = /^[ \t]*\[/;
const URL_LINE = /^([ \t]*url[ \t]*=[ \t]*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/;
const INLINE_OR_DOTTED_ERKLE = /(^|\n)[ \t]*(mcp_servers[ \t]*\.[ \t]*)?("erkle"|'erkle'|erkle)[ \t]*(\.[^=\n]*)?=/;
// `mcp_servers = { ... }` can't be extended by a later [mcp_servers.erkle] table.
const INLINE_SERVERS = /^[ \t]*("mcp_servers"|'mcp_servers'|mcp_servers)[ \t]*=/;
// Any other header naming erkle under mcp_servers (quoted keys, a lone subtable).
const OTHER_ERKLE_HEADER = /^[ \t]*\[[^\]]*mcp_servers[^\]]*erkle/;

/** A line without its trailing CR, for matching in CRLF files. */
const bare = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * Add `[mcp_servers.erkle]` to a Codex config.toml as text. The file is never
 * re-serialized, so comments and formatting survive byte for byte.
 */
export function planCodex(path: string, existing: string | null, url: string, force: boolean, display: string): FileChange {
  const table = `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\n`;
  if (existing === null) {
    return { kind: 'file', path, action: 'create', summary: 'add [mcp_servers.erkle]', content: table };
  }

  const eol = lineEnding(existing);
  const lines = existing.split('\n');
  const bareLines = lines.map(bare);
  const start = bareLines.findIndex((l) => HEADER.test(l));
  if (start === -1) {
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

  let end = bareLines.findIndex((l, i) => i > start && ANY_TABLE.test(l));
  if (end === -1) end = lines.length;
  let urlIdx = -1;
  let urlMatch: RegExpExecArray | null = null;
  for (let i = start + 1; i < end && !urlMatch; i++) {
    urlMatch = URL_LINE.exec(bareLines[i]!);
    if (urlMatch) urlIdx = i;
  }
  const current = urlMatch ? parseTomlString(urlMatch[2]!) : null;

  if (current === url) {
    return { kind: 'file', path, action: 'unchanged', summary: '[mcp_servers.erkle] already set' };
  }
  if (!force) {
    const what = current === null ? 'has no url' : `points to ${current}`;
    return { kind: 'file', path, action: 'conflict', summary: `[mcp_servers.erkle] ${what}; pass --force to replace` };
  }

  const next = [...lines];
  const cr = eol === '\r\n' ? '\r' : '';
  if (urlMatch) {
    const [, prefix, , rest] = urlMatch;
    next[urlIdx] = `${prefix}${JSON.stringify(url)}${rest}${lines[urlIdx]!.endsWith('\r') ? '\r' : ''}`;
  } else {
    next.splice(start + 1, 0, `url = ${JSON.stringify(url)}${cr}`);
  }
  return { kind: 'file', path, action: 'update', summary: 'update [mcp_servers.erkle] url', content: next.join('\n') };
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
