# headwater

A local-first tool that records and makes observable the **handoff of state between AI surfaces** —
a Claude Desktop chat, a Claude Code session, other agents.

Memory tools remember *what was learned*. headwater models *how it moves*: the concepts that flow
between surfaces, where they came from (lineage), and the handoffs that carry them.

This is **v1** — the smallest thing that closes one real loop:
**write a concept → recall it → fork it → hand it off → return the handoff**, all observable on a static page.

## Stack

TypeScript on **Bun** (package manager + runtime; no build step). The only runtime dependencies are the
official **MCP TypeScript SDK** and **zod**. Everything else is a Bun built-in: `bun:sqlite` for the pool,
`bun:test` for tests, `Bun.write` + template literals for the observation page.

## Install

```sh
bun install
```

## Data

One authoritative SQLite pool, stored **outside the repo**:

- Default: `~/.workspace/pool.db`
- Override the directory with the `HANDOFF_DATA_DIR` environment variable.

The repo holds code only — the pool, `*.db`, and the generated `index.html` are git-ignored.

### Model (six tables)

`project`, `surface`, `concept`, `lineage`, `handoff`, `handoff_concept`.

Key invariants: **concepts are immutable** (a fork is a new row plus a lineage edge — the original is never
touched), **lineage is append-only** (child → parent edges; the original is the canonical root), and a
handoff's `payload_snapshot` + `directive` are **frozen at creation** (only its status/return fields move).

## MCP tools (six)

| Tool | What it does |
| --- | --- |
| `write_concept` | Create a new immutable concept (origin = the calling surface). |
| `fork_concept` | Create a new concept from a parent + a lineage edge new→parent. Original untouched. |
| `read_concept` | Recall a concept by id (first-class path). |
| `read_project_state` | Session-kickoff context: concepts by status, pending handoffs, recents. |
| `open_handoff` | Open a `pending` handoff carrying named concepts (frozen JSON snapshot). |
| `return_handoff` | Mark a handoff `returned` with a return note. |

## Usage

```sh
bun run start    # start the MCP server (stdio transport)
bun run render   # read the pool and write a static ./index.html
bun run serve    # live viewer at http://localhost:8765 with a Refresh button (re-renders on click)
bun test         # run the end-to-end loop smoke test
```

Observe concepts (grouped by status), the lineage tree, and the handoff timeline two ways: open the
generated static `index.html`, or run `bun run serve` and open the printed URL — there a **Refresh**
button re-renders the page from the pool on demand (override the port with `HEADWATER_VIEW_PORT`). Both
are read-only and never mutate pool data.

## Scope (v1)

Deliberately small. **Not** included: full-text/semantic recall, auth/multi-user/teams, cloud/sync,
automatic cross-reference discovery, graph-visualization libraries, or orchestration. See `CLAUDE.md`
for the full architecture and scope fence.

## How to connect

headwater is a **stdio** MCP server launched with `bun run`. Point your client at the entry file by
**absolute path** (so it works regardless of the client's working directory). The pool lives at
`~/.workspace/pool.db` no matter where the server is started; set `HANDOFF_DATA_DIR` to relocate it.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "headwater": {
      "command": "bun",
      "args": ["run", "D:\\Repository\\headwater\\src\\index.ts"]
    }
  }
}
```

On macOS/Linux use a POSIX path, e.g. `"args": ["run", "/Users/you/headwater/src/index.ts"]`. To relocate
the pool, add `"env": { "HANDOFF_DATA_DIR": "/custom/path" }`. Restart Claude Desktop to pick up the change.

### Claude Code

Add it from the repo root with the CLI (the `--` separates headwater's launch command):

```sh
claude mcp add headwater -- bun run D:\Repository\headwater\src\index.ts
```

Equivalently, commit a project-scoped `.mcp.json` with the same shape as the Claude Desktop snippet above.
Override the pool location with `--env HANDOFF_DATA_DIR=/custom/path`. Verify with `claude mcp list`.

> For local development from the repo root, `bun run start` launches the same server.

### Regenerate the observation page

```sh
bun run render   # reads the pool and (re)writes ./index.html — open it in a browser
```

## License

MIT © 2026 YKnowMe
