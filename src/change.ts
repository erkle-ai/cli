import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

export type Action = 'create' | 'update' | 'unchanged' | 'conflict';

export type FileChange =
  | {
      kind: 'file';
      path: string;
      action: 'create' | 'update';
      summary: string;
      content: string;
      /** The bytes the plan was computed from (null: no file), checked again before writing. */
      before?: string | null;
    }
  | { kind: 'file'; path: string; action: 'unchanged' | 'conflict'; summary: string };

export interface CommandChange {
  kind: 'command';
  path: string;
  action: Action;
  summary: string;
  commands: string[][];
  /** Run when a command fails, to restore what earlier commands removed. */
  rollback: string[][];
}

export type Change = FileChange | CommandChange;

export class InitError extends Error {}

export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The file's line ending, so edits don't mix CRLF and LF. */
export function lineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Blank lines to put between existing text and an appended section. */
export function appendSeparator(existing: string, eol = '\n'): string {
  if (existing === '' || existing.endsWith(eol + eol)) return '';
  return existing.endsWith(eol) ? eol : eol + eol;
}

export function withEol(text: string, eol: string): string {
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/** Whether `path` is inside directory `root` (both absolute). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Where a write to `path` lands once symlinks in it and its parents are followed. */
export function resolveTarget(path: string): string {
  let dir = path;
  const rest: string[] = [];
  while (!existsSync(dir)) {
    rest.unshift(basename(dir));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(realpathSync(dir), ...rest);
}
