import { parseArgs } from 'node:util';
import { type Command, COMMON_HELP, COMMON_OPTIONS, type Context, usageHint } from './commands/command.js';
import { login, logout, token, whoami } from './commands/auth.js';
import { init } from './commands/init.js';
import { keysCreate, keysList, keysRevoke } from './commands/keys.js';
import { status } from './commands/status.js';
import { projects, teamList, teamUse } from './commands/team.js';
import { CliError, errorDocument, exitCodeFor, type Failure, printable, successDocument, UsageError } from './output.js';
import type { AgentId, Machine } from './probe.js';

export interface Prompts {
  selectAgents(options: { value: AgentId; label: string; hint: string }[], initial: AgentId[]): Promise<AgentId[] | null>;
  confirm(message: string): Promise<boolean | null>;
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
  prompts: Prompts;
  version: string;
}

/** Every subcommand, in help order. A two-word name (`keys create`) makes its first word a group. */
export const COMMANDS: readonly Command[] = [init, login, logout, whoami, token, teamList, teamUse, projects, keysCreate, keysList, keysRevoke, status];

function help(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length)) + 2;
  return `Usage: erkle <command> [options]

Erkle is your team's shared memory for coding agents.

Commands:
${commands.map((c) => `  ${c.name.padEnd(width)}${c.summary}\n`).join('')}
Every command accepts:
${COMMON_HELP}
With --json, stdout carries exactly one JSON document and nothing prompts.
Exit codes: 0 success (including a pending approval), 1 error, 2 bad usage.

Run \`erkle <command> --help\` for a command's options, JSON fields, and
environment variables.
`;
}

export async function run(argv: string[], m: Machine, raw: Io, commands: readonly Command[] = COMMANDS): Promise<number> {
  const scan = scanArgs(argv);
  // With --json, stdout carries only the document: human text moves to
  // stderr, and nothing prompts.
  const io: Io = {
    ...raw,
    out: (t) => (scan.json ? raw.err : raw.out)(printable(t)),
    err: (t) => raw.err(printable(t)),
    interactive: raw.interactive && !scan.json,
  };
  const ctx: Context = { m, io, json: scan.json };
  try {
    const route = resolve(argv, scan, commands);
    if (scan.version) return done(raw, ctx, 'version', { version: raw.version }, `${raw.version}\n`);
    if (route.kind === 'help') return done(raw, ctx, 'help', { topic: route.topic, help: route.text }, route.text);
    if (route.kind === 'none') {
      if (scan.json) throw new UsageError('no command given', { hint: usageHint() });
      io.out(help(commands));
      return 2;
    }
    const outcome = await route.command.run(route.args, ctx);
    if (scan.json) raw.out(successDocument(route.command.name, outcome.data));
    return 0;
  } catch (err) {
    // The one place errors become codes.
    let f: Failure;
    if (err instanceof CliError) {
      f = { code: err.code, message: err.message, hint: err.hint ?? (err.code === 'usage' ? usageHint() : null) };
      if (err.reason !== undefined) f.reason = err.reason;
    } else if (typeof (err as NodeJS.ErrnoException).code === 'string' && (err as NodeJS.ErrnoException).syscall) {
      // A file we couldn't read while planning (a directory where a file
      // should be, a permission error). Planning writes nothing.
      f = { code: 'file_unsafe', message: `${(err as Error).message}. Nothing was changed.`, hint: null };
    } else {
      throw err;
    }
    if (scan.json) raw.out(errorDocument(f, err instanceof CliError ? err.data : undefined));
    else if (f.code === 'usage') io.err(`erkle: ${f.message}\n${f.hint}\n`);
    else io.err(`✖ ${f.message}\n${f.hint ? `  ${f.hint}\n` : ''}`);
    return exitCodeFor(f.code);
  }
}

function done(raw: Io, ctx: Context, command: string, data: Record<string, unknown>, text: string): number {
  if (ctx.json) raw.out(successDocument(command, data));
  else ctx.io.out(text);
  return 0;
}

interface Scan {
  json: boolean;
  help: boolean;
  version: boolean;
  words: { index: number; value: string }[];
}

/**
 * A lenient first pass, before the command's own strict parse: finds the
 * command words and the flags that change how output is written, wherever
 * they appear. Stops at `--`.
 */
function scanArgs(argv: string[]): Scan {
  const { values, tokens } = parseArgs({ args: argv, options: COMMON_OPTIONS, strict: false, allowPositionals: true, tokens: true });
  const words = tokens.flatMap((t) => (t.kind === 'positional' ? [{ index: t.index, value: t.value }] : []));
  const cut = tokens.find((t) => t.kind === 'option-terminator');
  return {
    json: values.json === true,
    help: values.help === true,
    version: values.version === true,
    words: cut ? words.filter((w) => w.index < cut.index) : words,
  };
}

type Route =
  | { kind: 'command'; command: Command; args: string[] }
  | { kind: 'help'; topic: string | null; text: string }
  | { kind: 'none' };

/**
 * The command is the first positional word that names one (so flags may come
 * first), plus the next word when the first is a group like `keys`.
 */
function resolve(argv: string[], scan: Scan, commands: readonly Command[]): Route {
  const first = (n: string) => n.split(' ')[0]!;
  const at = scan.words.findIndex((w) => commands.some((c) => first(c.name) === w.value));
  if (at === -1) {
    if (scan.help || scan.version) return { kind: 'help', topic: null, text: help(commands) };
    if (scan.words.length === 0) return { kind: 'none' };
    throw new UsageError(`unknown command: ${scan.words.map((w) => w.value).join(' ')}`, { hint: usageHint() });
  }
  const word = scan.words[at]!;
  const next = scan.words[at + 1];
  const group = commands.filter((c) => c.name.startsWith(`${word.value} `));
  let command = commands.find((c) => c.name === word.value);
  let used = [word.index];
  if (group.length) {
    const sub = next && group.find((c) => c.name === `${word.value} ${next.value}`);
    if (sub) {
      command = sub;
      used = [word.index, next.index];
    } else if (!command) {
      const names = group.map((c) => c.name.slice(word.value.length + 1)).join(', ');
      const groupHelp = `Usage: erkle ${word.value} <${names.replace(/, /g, '|')}> [options]\n\n${group
        .map((c) => `  erkle ${c.name.padEnd(24)}${c.summary}\n`)
        .join('')}`;
      if (scan.help) return { kind: 'help', topic: word.value, text: groupHelp };
      if (next) throw new UsageError(`unknown command: ${word.value} ${next.value}`, { hint: usageHint(word.value) });
      throw new UsageError(`${word.value} needs a subcommand: ${names}`, { hint: usageHint(word.value) });
    }
  }
  if (scan.help) return { kind: 'help', topic: command!.name, text: command!.help };
  return { kind: 'command', command: command!, args: argv.filter((_, i) => !used.includes(i)) };
}
