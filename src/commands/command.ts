import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { UsageError } from '../output.js';
import type { Machine } from '../probe.js';
import type { Io } from '../run.js';

export interface Context {
  m: Machine;
  /**
   * Human text. `out` is stdout normally and stderr with `--json`; both strip
   * control characters. `interactive` is false with `--json`, so a command
   * never prompts while stdout carries a document.
   */
  io: Io;
  json: boolean;
}

export interface Outcome {
  /** Fields of the `--json` success document, after `ok`, `schemaVersion` and `command`. */
  data?: Record<string, unknown>;
}

/**
 * One subcommand. `name` is one or two words (`init`, `keys create`); the
 * router strips those words from `args` and handles `--help`, `--version` and
 * `--json` output, so `run` only parses its own options with `parseCommand`.
 */
export interface Command {
  name: string;
  summary: string;
  help: string;
  run(args: string[], ctx: Context): Promise<Outcome>;
}

export const COMMON_OPTIONS = {
  json: { type: 'boolean', default: false },
  url: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const satisfies ParseArgsOptionsConfig;

export const COMMON_HELP = `  --json              print one JSON document on stdout; progress goes to stderr
  --url <url>         Erkle MCP server URL (default https://erkle.ai/mcp, or $ERKLE_URL)
  -h, --help          show this help
  -v, --version       show the version
`;

/** Two-column help rows: the name padded to 20 columns, the text wrapped under itself. */
function rows(entries: readonly (readonly [string, string])[]): string {
  const width = 76;
  return entries
    .map(([name, text]) => {
      const lines: string[] = [];
      let line = '';
      for (const word of text.split(' ')) {
        if (line && line.length + 1 + word.length > width - 22) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      lines.push(line);
      const first = `  ${name}`;
      return `${first.length < 22 ? first.padEnd(22) : `${first}\n${''.padEnd(22)}`}${lines.join(`\n${''.padEnd(22)}`)}\n`;
    })
    .join('');
}

/**
 * The `--json` section of a command's help: the fields its success document
 * carries after `ok`, `schemaVersion` and `command`.
 */
export function jsonHelp(fields: readonly (readonly [string, string])[]): string {
  return `With --json, success is {"ok": true, "schemaVersion": 1, "command", ...} with:
${rows(fields)}A failure has "ok": false and "error": {"code", "message", "hint"}.
`;
}

export const ENV = {
  ERKLE_URL: 'the MCP server URL when --url is not given',
  ERKLE_TOKEN: 'a session token from `erkle token`, used instead of the stored sign-in',
  ERKLE_TOKEN_ORIGIN: 'one server besides https://erkle.ai that ERKLE_TOKEN and ERKLE_API_KEY may be sent to',
  ERKLE_CONFIG_DIR:
    'where the credentials file and pending requests live (default $XDG_CONFIG_HOME/erkle, %APPDATA%\\erkle on Windows, or ~/.config/erkle)',
} as const;

/** The variables a command that calls Erkle with the stored sign-in reads. */
export const SESSION_ENV = ['ERKLE_URL', 'ERKLE_TOKEN', 'ERKLE_TOKEN_ORIGIN', 'ERKLE_CONFIG_DIR'] as const;

/** The environment section of a command's help. A pair overrides or adds a description. */
export function envHelp(vars: readonly (keyof typeof ENV | readonly [string, string])[]): string {
  return `Environment:
${rows(vars.map((v) => (typeof v === 'string' ? ([v, ENV[v]] as const) : v)))}`;
}

/** Strict parse of a command's own options plus the common ones; a bad flag is a usage error. */
export function parseCommand<const O extends ParseArgsOptionsConfig>(name: string, args: string[], options: O) {
  try {
    return parseArgs({ args, allowPositionals: true, options: { ...COMMON_OPTIONS, ...options } });
  } catch (err) {
    throw new UsageError((err as Error).message, { hint: usageHint(name) });
  }
}

export const usageHint = (name?: string) => `Run \`erkle ${name ? `${name} ` : ''}--help\` for usage.`;

export function noPositionals(name: string, positionals: string[]): void {
  if (positionals.length) throw new UsageError(`unexpected argument: ${positionals.join(' ')}`, { hint: usageHint(name) });
}
