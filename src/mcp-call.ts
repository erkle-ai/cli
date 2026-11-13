import { HttpError, networkError, REQUEST_TIMEOUT_MS, userAgent } from './http.js';
import { isObj } from './json-config.js';
import type { Machine } from './probe.js';

/**
 * One stateless MCP `tools/call` over HTTP, for checking what an API key can
 * reach. No session, no initialize: the server answers stateless requests at
 * this protocol version, as JSON or as one SSE-framed message.
 */

export const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface ToolResult {
  isError: boolean;
  /** The text content blocks, joined. */
  text: string;
  structuredContent: Record<string, unknown> | null;
}

/** Why the server refused the key, from its 401 description. */
export type KeyRejection = 'not_recognized' | 'expired' | 'revoked';

// Matched by prefix: the server may append a hint after the reason.
const REJECTIONS: [string, KeyRejection][] = [
  ['API key not recognized', 'not_recognized'],
  ['API key expired', 'expired'],
  ['API key revoked', 'revoked'],
];

export class KeyRejectedError extends Error {
  constructor(
    readonly reason: KeyRejection | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

/** `error_description` from a WWW-Authenticate challenge or an OAuth-style JSON body. */
function rejectionDescription(res: Response, body: string): string | null {
  const header = /error_description="((?:[^"\\]|\\.)*)"/.exec(res.headers.get('www-authenticate') ?? '');
  if (header) return header[1]!.replace(/\\(.)/g, '$1');
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObj(parsed) && typeof parsed.error_description === 'string') return parsed.error_description;
  } catch {
    // Not JSON; nothing more to read.
  }
  return null;
}

export function rejectionReason(description: string | null): KeyRejection | 'unknown' {
  const d = description?.trim() ?? '';
  return REJECTIONS.find(([prefix]) => d.startsWith(prefix))?.[1] ?? 'unknown';
}

/** The JSON-RPC messages in a JSON body or an SSE stream (`data:` lines, events split by a blank line). */
export function rpcMessages(body: string, contentType: string): unknown[] {
  const trimmed = body.trim();
  if (!contentType.includes('text/event-stream') && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const out: unknown[] = [];
  for (const event of body.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const data = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data.trim() === '') continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // A keep-alive or a non-JSON event; skip it.
    }
  }
  return out;
}

/**
 * POST `tools/call` for `name` to `url` with `key` as the bearer. A 401 throws
 * KeyRejectedError; transport and protocol failures throw HttpError.
 */
export async function callTool(m: Machine, version: string, url: string, key: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const id = 1;
  const init: RequestInit = {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'user-agent': userAgent(version),
      authorization: `Bearer ${key}`,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  };
  const origin = new URL(url).origin;

  let res: Response;
  try {
    res = await m.fetch(url, init, REQUEST_TIMEOUT_MS);
  } catch (err) {
    throw networkError(origin, err);
  }
  const body = await res.text().catch(() => '');

  if (res.status === 401) {
    const description = rejectionDescription(res, body);
    throw new KeyRejectedError(rejectionReason(description), description ?? `${origin} rejected the API key.`);
  }
  if (res.status === 429) throw new HttpError('rate_limited', 'Too many requests.', 429, { hint: 'Wait a minute, then run the same command again.' });
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError('server', `${origin} answered the MCP request with ${res.status}.`, res.status, { hint: 'Run the same command again in a minute.' });
  }

  let messages: unknown[];
  try {
    messages = rpcMessages(body, res.headers.get('content-type') ?? '');
  } catch {
    messages = [];
  }
  const reply = messages.find((msg) => isObj(msg) && msg.id === id && ('result' in msg || 'error' in msg)) as Record<string, unknown> | undefined;
  if (!reply) throw new HttpError('server', `${origin} sent no answer to the MCP request.`, res.status, { hint: 'Check --url points at an Erkle MCP server.' });
  if (isObj(reply.error)) {
    const message = typeof reply.error.message === 'string' ? reply.error.message : 'unknown error';
    throw new HttpError('server', `${origin} answered the MCP request with an error: ${message}`, res.status);
  }
  const result = isObj(reply.result) ? reply.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    isError: result.isError === true,
    text: content
      .filter((c): c is { type: 'text'; text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n'),
    structuredContent: isObj(result.structuredContent) ? result.structuredContent : null,
  };
}
