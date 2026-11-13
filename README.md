<p align="center">
  <a href="https://erkle.ai"><img src="assets/logo.svg" width="96" height="96" alt="Erkle logo"></a>
</p>

<h1 align="center">@erkle/cli</h1>

<p align="center">
  Connect Claude Code, Cursor and Codex to <a href="https://erkle.ai">Erkle</a>, shared team memory for AI coding agents, in one command.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@erkle/cli"><img src="https://img.shields.io/npm/v/@erkle/cli?color=86d39a&labelColor=0e1014" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@erkle/cli?color=86d39a&labelColor=0e1014" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/@erkle/cli?color=86d39a&labelColor=0e1014" alt="Node version">
</p>

```sh
npx @erkle/cli init
```

Your agents forget what your team decided. One teammate's Claude Code learns
that the billing service must never retry a charge; tomorrow another
teammate's Cursor retries it. `CLAUDE.md` helps inside one repo, but it doesn't
travel across repos, tools, or people, and nobody reviews what goes in it.
Erkle gives every agent on the team the same reviewed memory.

## What it looks like

After `init`, a session goes like this (illustrative):

```text
You:    Add retries to the charge endpoint.

Agent:  [memory_search "charge endpoint retries" repo=acme/billing]
        Found 1 constraint (team scope, approved by Dana):
        "Never retry POST /charges. Stripe idempotency keys expire after 24h,
         and a retry after that double-charges. Retry only the webhook."
        I'll add retries to the webhook handler instead and leave /charges alone.

        ...

Agent:  I learned the webhook handler must be idempotent on event.id.
        Propose it as a convention for acme/billing? [y/n]
You:    y
Agent:  [memory_create] Proposed. A maintainer reviews it before it goes live.
```

## What is Erkle?

[Erkle](https://erkle.ai) is shared, reviewed team memory for AI coding
agents. It's a hosted MCP server (`https://erkle.ai/mcp`) where your team's
decisions, conventions, constraints and lessons live, scoped to the team, a
project, or a repository. Agents search it before a task and propose what
they learned after; maintainers review proposals before they go live. One
memory works across Claude Code, Cursor, Codex and claude.ai, so every
teammate's agent knows what the team knows.

`@erkle/cli` is the setup step: `erkle init` wires your agents to that server
and tells them how to use it. On a machine where an agent can't open a
browser, the CLI can also sign you in from the terminal and make an API key
for the agents to use instead (see
[Remote and headless machines](#remote-and-headless-machines)).

Run it in a git repository (installed globally, the command is `erkle init`).
It:

1. Adds the `erkle` MCP server to each agent you pick (Claude Code, Cursor,
   Codex).
2. Adds a short instructions block to `AGENTS.md` / `CLAUDE.md`, so agents
   search Erkle before a task and propose what they learned after.
3. Prints the sign-in step for each agent and a first-run prompt that imports
   what the repo already knows.

`init` never signs in and never talks to Erkle. Each agent runs its own
browser sign-in the first time it connects.

## What it writes

| Agent | Project (default) | `--global` |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `claude mcp add --scope user` (`~/.claude.json`) |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Codex | `.codex/config.toml` (loaded once you trust the project) | `~/.codex/config.toml` |

Project files live in the repo root, so commit them and every teammate gets
the same setup.

Instructions go between `<!-- erkle:start -->` and `<!-- erkle:end -->` in
`AGENTS.md` and `CLAUDE.md`, whichever exist. A `CLAUDE.md` that is a
symlink to `AGENTS.md`, or that imports it with an `@AGENTS.md` line, is left
alone so the block appears once. If neither file exists, `init` creates
`AGENTS.md`, which Claude Code, Cursor and Codex all read. Re-running replaces
only the text between the markers.

Existing files keep everything else: other MCP servers, other keys, JSON
indentation, and TOML comments. If a file can't be parsed (JSON with
comments, for example) `init` stops and writes nothing. If an `erkle` entry
already points somewhere else, `init` reports it as a conflict and leaves it
alone unless you pass `--force`; everything else in the plan is still
applied.

`init` treats the repo as untrusted, since it may be a fresh clone. If a
project file is a symlink that resolves outside the repo, `init` stops and
writes nothing. An existing `erkle` entry with keys that can run code
(`command`, `env`, `headersHelper`, ...) is a conflict too. If a file changes
between the plan and the write, `init` stops instead of overwriting it.

Running `init` again when everything is set up changes nothing.

## Options

```text
--agents <list>     claude,cursor,codex (default: ask, or the detected ones)
--auth <mode>       oauth (default) or key; key writes user-level config only
--global            write user-level config instead of the repo's
--url <url>         MCP server URL (default https://erkle.ai/mcp, or $ERKLE_URL)
-y, --yes           apply without asking
--dry-run           print the plan and write nothing
--force             replace an existing erkle entry with a different URL or,
                    with --auth key, its own Authorization header
--no-instructions   don't touch AGENTS.md / CLAUDE.md
--json              print one JSON document on stdout
-h, --help          show help
-v, --version       show the version
```

Exit codes: `0` success, nothing to do, or cancelled at the prompt; `1` error
(nothing written); `2` bad usage. When stdin or stdout isn't a terminal,
`init` won't ask, so pass `--yes` to apply (or `--dry-run` to preview);
without either it exits `2`.

For local development against a dev server:

```sh
ERKLE_URL=http://localhost:8080/mcp npx @erkle/cli init
```

## Remote and headless machines

An agent's own sign-in opens a browser on the machine it runs on. On a
server, over SSH, or in a container there is no browser to open, so give the
agents an API key instead. These commands need an Erkle server that supports
CLI sign-in.

Sign in once. `erkle login` prints a link and a code; open the link on any
device (your laptop, your phone), enter the code, and pick the team to start
on:

```sh
npx @erkle/cli login
```

Make a key and write it to a private env file instead of the screen:

```sh
erkle keys create --env-file ~/.erkle.env
```

Keys are read-only by default. `--write` lets agents write memories,
`--projects a,b` limits the key to those projects (`erkle projects` lists
them), and `--expires <days>` sets its life (30 days by default, at most
365). If your team requires browser approval for keys made from the CLI,
`keys create` prints a link to approve first.

Load the file in your shell profile (`~/.zshrc`, `~/.bashrc`) so every agent
you start has the key:

```sh
set -a; . ~/.erkle.env; set +a
```

Point the agents at it. `--auth key` writes user-level config that reads the
key from `ERKLE_API_KEY`; the key itself is never written to a config file:

```sh
erkle init --auth key
```

Then check what the agents will reach:

```sh
erkle status
```

`status` shows how each agent connects, checks your sign-in, and, when
`ERKLE_API_KEY` is set, which team and projects the key reaches and whether
it can write.

The other commands: `erkle whoami` shows the account, teams, and session;
`erkle team list` and `erkle team use <team>` pick the team keys are made
in; `erkle keys list` and `erkle keys revoke <id>` manage keys. Run
`erkle <command> --help` for each command's options.

## For agents

Every command is safe to run from an agent.

- `--json` prints exactly one JSON document on stdout, and progress text
  goes to stderr. A success is `{"ok": true, "schemaVersion": 1, "command":
  "keys create", ...}`; a failure is `{"ok": false, "schemaVersion": 1,
  "error": {"code", "message", "hint"}}`, where the hint names the next
  command to run. Each command's `--help` lists its fields.
- Error codes: `usage`, `not_signed_in`, `session_expired`,
  `session_revoked`, `no_team`, `forbidden`, `not_found`,
  `approval_required`, `denied`, `expired`, `key_rejected`, `rate_limited`,
  `network`, `server`, `conflict`, `file_unsafe`.
- Exit codes: `0` success, including a pending approval; `1` error; `2` bad
  usage.
- Without a terminal, nothing prompts. Commands that would ask first
  (`init`, `keys revoke`) or print a secret (`token`) need `--yes` instead.
- `login`, and `keys create` when the team requires approval, wait for a
  person to approve in a browser. Without a terminal they wait at most 90
  seconds (`--timeout <s>` changes that; `--no-wait` returns at once), then
  return `"status": "pending"` with the link, the code, and a `resume`
  command such as `erkle login --resume`. Show the person the link and code,
  then run the `resume` command once they have approved.

## Credentials

The CLI keeps its sign-ins in `credentials.json` in its config directory,
the first of `$ERKLE_CONFIG_DIR`, `$XDG_CONFIG_HOME/erkle`, `%APPDATA%\erkle`
on Windows, and `~/.config/erkle`. The file is mode 0600 and holds one
session per server, and the CLI only sends the session for the server it is
talking to. It refuses a config directory inside a git repository. Pending
approvals live next to it under `pending/` until they are collected.

A session lasts 30 days and can only manage keys: it can't read or write
memories. `login` never prints it.

`ERKLE_TOKEN` takes the place of the stored session, for CI. It is only sent
to `https://erkle.ai` and to the one server named in `ERKLE_TOKEN_ORIGIN`, so a
repo's `.env` that sets `ERKLE_URL` can't send your token somewhere else.
`ERKLE_API_KEY` follows the same rule in `status`.

`erkle token` creates a separate session for a CI secret and prints its
token; it is the only command that prints one. Signing in or out on your
machine doesn't affect it.

`erkle logout` ends the session on the server and removes it from this
machine. `erkle logout --revoke-keys` also revokes every key that session
created. Resetting your Erkle password ends all of your CLI sessions, and
the keys they created stop working.

## FAQ

**Does `init` need an Erkle account or API key?** No. It only writes config
files. Each agent opens a browser OAuth sign-in the first time it connects.
Where that can't work, use an API key instead; see
[Remote and headless machines](#remote-and-headless-machines).

**Which agents are supported?** Claude Code, Cursor and Codex. claude.ai
connects to the same server as a custom connector; see
[erkle.ai](https://erkle.ai).

**How is this different from `CLAUDE.md` or `AGENTS.md`?** Instruction files
live in one repo and change by commit. Erkle is shared across repos and tools,
scoped by team, project and repo, permissioned, and reviewed. `init` keeps a
short block in your instruction files that points agents at Erkle; see
[Erkle vs. AGENTS.md](https://erkle.ai/compare/agents-md).

**What does it cost?** $5 per user per month, or $50 per user per year, after
a 7-day trial with no card needed. See [pricing](https://erkle.ai/pricing).

## Who maintains this

Erkle is built and operated by
[Justin Albrecht](https://www.linkedin.com/in/justin-albrecht-19a021bb/).
Development happens in a private repository. This public repository is the
release mirror: each release lands here as one commit made by the release
automation, which is why commits show `github-actions[bot]`, and its tag is
what gets published to npm. How Erkle itself handles your data is on the
[security page](https://erkle.ai/security).

## Bugs

Open an issue at [github.com/erkle-ai/cli](https://github.com/erkle-ai/cli/issues).
This repository receives one commit per release and doesn't take pull requests;
see [CONTRIBUTING](.github/CONTRIBUTING.md). Report vulnerabilities privately,
as described in [SECURITY](SECURITY.md).
