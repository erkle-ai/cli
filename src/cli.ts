#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import * as clack from '@clack/prompts';
import { REQUEST_TIMEOUT_MS } from './http.js';
import { type Machine } from './probe.js';
import { run } from './run.js';

// Exit quietly when piped into something that stops reading (`| head`).
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw err;
});

const machine: Machine = {
  cwd: process.cwd(),
  home: homedir(),
  env: process.env,
  which(cmd) {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(lookup, [cmd], { stdio: 'ignore' }).status === 0;
  },
  exec(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
  },
  fetch(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  hostname: () => hostname(),
  openBrowser,
};

/** Hand an http(s) URL to the platform's opener, with no shell in between. */
function openBrowser(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false);
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const code = await run(process.argv.slice(2), machine, {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  version: pkg.version,
  prompts: {
    async selectAgents(options, initial) {
      const r = await clack.multiselect({
        message: 'Which agents should use Erkle?',
        options,
        initialValues: initial,
        required: false,
      });
      return clack.isCancel(r) ? null : r;
    },
    async confirm(message) {
      const r = await clack.confirm({ message });
      return clack.isCancel(r) ? null : r;
    },
  },
});
process.exitCode = code;
