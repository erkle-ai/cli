import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writePrivateFile } from './credentials.js';
import { CliError } from './output.js';
import type { Machine } from './probe.js';
import { API_KEY_ENV } from './text.js';

/**
 * `keys create --env-file`: the one place besides the credentials file where
 * the CLI writes a secret, and only because the person asked for it. The file
 * keeps its other lines, ends up with one ERKLE_API_KEY= line, and is 0600.
 */

const KEY_LINE = new RegExp(`^\\s*(export\\s+)?${API_KEY_ENV}=`);

/** The absolute path for `--env-file`, with a leading `~/` meaning home (for `--env-file=~/…`, which the shell leaves alone). */
export function envFilePath(m: Machine, given: string): string {
  if (given === '~' || given.startsWith('~/')) return join(m.home, given.slice(1));
  return resolve(m.cwd, given);
}

function unsafe(path: string, why: string): CliError {
  return new CliError('file_unsafe', `Refusing to write ${path}: ${why}.`, { hint: 'Pass --env-file a regular file you own, such as ~/.erkle.env.' });
}

/**
 * Fails unless `path` is a regular file or does not exist yet, in a directory
 * that exists. Checked before a key is made, so a bad path never costs one.
 */
export function checkEnvFile(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw unsafe(path, (err as Error).message);
    st = null;
  }
  if (st?.isSymbolicLink()) throw unsafe(path, 'it is a symlink');
  if (st && !st.isFile()) throw unsafe(path, 'it is not a regular file');
  let dir;
  try {
    dir = lstatSync(dirname(path), { throwIfNoEntry: false });
  } catch (err) {
    throw unsafe(path, (err as Error).message);
  }
  if (!dir) throw unsafe(path, `${dirname(path)} does not exist`);
}

/** Characters a shell sourcing the file would split on, quote, or expand. */
const UNSAFE_VALUE = /[\s'"$`\\]/;

/**
 * `text` with its ERKLE_API_KEY line set to `key`: the first such line
 * replaced, any others dropped, or one appended. Throws on a key the file
 * could not hold as a bare word, since the file is meant to be sourced.
 */
export function withKey(text: string, key: string): string {
  if (key === '' || UNSAFE_VALUE.test(key)) throw new Error('The key has characters that are not safe in an env file.');
  const lines = text === '' ? [] : text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    const match = KEY_LINE.exec(line);
    if (!match) {
      out.push(line);
    } else if (!replaced) {
      out.push(`${match[1] ? 'export ' : ''}${API_KEY_ENV}=${key}`);
      replaced = true;
    }
  }
  if (!replaced) out.push(`${API_KEY_ENV}=${key}`);
  return `${out.join('\n')}\n`;
}

/** Writes the key through a fresh 0600 temp file in the same directory, then renames it over `path`. */
export function writeEnvFile(path: string, key: string): void {
  checkEnvFile(path);
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw unsafe(path, (err as Error).message);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.erkle.tmp`);
  try {
    writePrivateFile(path, tmp, withKey(text, key));
  } catch (err) {
    throw unsafe(path, (err as Error).message);
  }
}

/**
 * A warning when `path` sits in a git work tree and git does not ignore it,
 * so the key could be committed. Git runs from home, not from the repo, as
 * `probe` does.
 */
export function gitExposure(m: Machine, path: string): string | null {
  const dir = dirname(path);
  const inside = m.exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], m.home);
  if (!inside.ok || inside.stdout.trim() !== 'true') return null;
  // Exit 0 means ignored. A tracked file counts as not ignored, which is right: it would be committed.
  if (m.exec('git', ['-C', dir, 'check-ignore', '-q', '--', path], m.home).ok) return null;
  return `${path} is inside a git work tree and git does not ignore it; add it to .gitignore so the key is never committed.`;
}

/** A path as a shell word: bare when safe, single-quoted otherwise. */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
