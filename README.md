# @erkle/cli

Connect your coding agents to [Erkle](https://erkle.ai), your team's shared
memory, in one command.

```sh
npx @erkle/cli init
```

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
--global            write user-level config instead of the repo's
--url <url>         MCP server URL (default https://erkle.ai/mcp, or $ERKLE_URL)
-y, --yes           apply without asking
--dry-run           print the plan and write nothing
--force             replace an existing erkle entry that has a different URL
--no-instructions   don't touch AGENTS.md / CLAUDE.md
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

## Bugs

Open an issue at [github.com/erkle-ai/cli](https://github.com/erkle-ai/cli/issues).
This repository receives one commit per release and doesn't take pull requests;
see [CONTRIBUTING](.github/CONTRIBUTING.md).
