# headwater

A local-first tool that records and makes observable the **handoff of state between AI surfaces** —
a Claude Desktop chat, a Claude Code session, other agents.

Memory tools remember *what was learned*. headwater models *how it moves*: the concepts that flow
between surfaces, where they came from (lineage), and the handoffs that carry them.

This is **v1** — the smallest thing that closes one real loop:
**write a concept → recall it → fork it → hand it off → return the handoff**, all observable in a local viewer.

## Demo

![headwater demo](docs/demo.gif)

One command seeds a disposable, repo-local pool (`.demo/`, git-ignored — **never your real pool**) with a
small *checkout redesign* moving between a planning chat and a coding session, then serves the page:

```sh
bun install
bun run demo          # seed .demo/ with the example (wipes + repopulates, so re-running is safe)
bun run demo:serve    # live viewer — open the printed http://127.0.0.1:8765
```

What to look at:

- **Lineage tree** — the locked root checkout decision with a **supersede** branch (a refined version; the
  original stays the canonical root) and a separate **operator annotation**: immutability-by-fork, made visible.
- **Handoff timeline** — one **returned** loop (planning → code, implemented) and one **pending** loop (an
  open product question awaiting a call).
- **Rich bodies** — expand *Checkout state machine* for a rendered **Mermaid** diagram; the payment decision
  carries a **pipe table**.
- **Type × status matrix** — fills in across decisions, architecture, a constraint, and a parked question.

## Stack

TypeScript on **Bun** (package manager + runtime; no build step). The only runtime dependencies are the
official **MCP TypeScript SDK** and **zod**. Everything else is a Bun built-in: `bun:sqlite` for the pool,
`bun:test` for tests, `Bun.write` + template literals for the observation page. The live viewer renders
rich concept bodies and `mermaid` diagrams via one **vendored** static asset — Mermaid v11.15.0
(`vendor/mermaid.min.js`, MIT; see `vendor/mermaid.LICENSE`) served only to the browser — so the two
runtime dependencies are unchanged.

## Install

```sh
bun install
```

## Data

One authoritative SQLite pool, stored **outside the repo**:

- Default: `~/.workspace/pool.db`
- Override the directory with the `HEADWATER_DATA_DIR` environment variable.

The repo holds code only — the pool, `*.db`, and the generated `index.html` are git-ignored.

### Backup and restore

The pool is the only copy of your state and it lives outside the repo, so git does not protect it.

```bash
bun run backup
```

This takes a **consistent snapshot of the live pool** with `VACUUM INTO` over a read-only connection —
safe to run while `bun run serve` and any MCP clients are attached. It verifies the snapshot
(`PRAGMA integrity_check`, plus a check that the append-only tables never shrank), then writes
timestamped copies to two places and prunes each to the newest 14:

| Destination | Default | Protects against |
| --- | --- | --- |
| local history | `<data dir>/backups/` | a bad write, a botched merge |
| offsite | `~/OneDrive/headwater-backups/` | a dead disk |

Override the offsite directory with `HEADWATER_BACKUP_DIR` and the retention count with
`HEADWATER_BACKUP_KEEP`. Any failure exits non-zero and prunes nothing. One failure still writes: if
the offsite destination is missing, the local snapshot is published anyway — you keep the history,
you just have no offsite copy, and the non-zero exit tells you so.

> **Do not back up the pool with `cp pool.db`.** The pool is in WAL mode, so committed transactions sit
> in `pool.db-wal` until a checkpoint. A file copy silently omits them — and the result still passes
> `integrity_check`, so it looks fine until you need it.

Run it daily with Task Scheduler. **In Command Prompt** (not PowerShell — `%USERPROFILE%` is cmd-only
expansion):

```bat
schtasks /Create /TN "headwater-backup" /F /SC DAILY /ST 09:00 /RL LIMITED /TR "%USERPROFILE%\.bun\bin\bun.exe run D:\Repository\headwater\scripts\backup.ts"
```

If the machine is asleep at the scheduled time the run is skipped; `schtasks` cannot set *"run task as
soon as possible after a missed start"*, so enable that once in the Task Scheduler GUI
(task → Properties → Settings).

#### Restoring

A snapshot is a complete, standalone database, so restoring is a copy — with one footgun. **If a stale
`pool.db-wal` is left beside the restored file, SQLite replays it on next open** and silently
reintroduces the state you were trying to escape. Deleting the sidecars is not optional.

These steps assume the default data directory. If you set `HEADWATER_DATA_DIR`, substitute it for
`~/.workspace` throughout.

1. Stop every writer: `bun run serve`, and every MCP client (Claude Code, Claude Desktop).
2. Move the current pool aside: `mv ~/.workspace/pool.db ~/.workspace/pool.db.pre-restore`
3. **Delete `~/.workspace/pool.db-wal` and `~/.workspace/pool.db-shm`.**
4. Copy the chosen snapshot into place: `cp ~/.workspace/backups/pool-<stamp>.db ~/.workspace/pool.db`
5. Verify: `bun -e "const {Database}=require('bun:sqlite'); const p=require('path').join(require('os').homedir(),'.workspace','pool.db'); const d=new Database(p,{readonly:true}); console.log(d.query('PRAGMA integrity_check').get(), d.query('SELECT count(*) AS c FROM concept').get()); d.close();"`
6. Restart `serve` and your clients.

This is deliberately manual: restore is rare, and step 1 is something no script can verify.

### Model (six tables)

`project`, `surface`, `concept`, `lineage`, `handoff`, `handoff_concept`.

Key invariants: **concepts are immutable** (a fork is a new row plus a lineage edge — the original is never
touched), **lineage is append-only** (child → parent edges; the original is the canonical root), and a
handoff's `payload_snapshot` + `directive` are **frozen at creation** (only its status/return fields move).
These are enforced **at the substrate** by SQLite triggers — a raw `sqlite3 pool.db "UPDATE …"` is rejected
too, not just the tool paths — so the integrity claim holds of the file itself.

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
bun run serve    # live viewer at http://127.0.0.1:8765 — read + write, re-renders from the pool per request
bun test         # run the test suite (the end-to-end loop + the viewer)
```

Observe concepts (grouped by status), the lineage tree, and the handoff timeline two ways:

- **Static** — `bun run render` writes a read-only `index.html` snapshot (pure HTML/CSS, no forms).
- **Live** — `bun run serve` starts a local viewer that re-renders from the pool on every request
  (a **Refresh** button reloads it; override the port with `HEADWATER_VIEW_PORT`).

### The live viewer

The live viewer is **read + write**, and richer than the static snapshot:

- **Rich concept bodies** — a body renders an escape-first markdown subset (headings, bold/italic/`code`,
  http(s) links + images, pipe tables, bullet/numbered lists, `- [ ]`/`- [x]` checklists) plus `mermaid`
  diagrams (rendered client-side by the vendored bundle; the static snapshot shows the source as a code
  block). `[[concept-id]]` citations resolve to in-page links — a dangling citation renders as a ghost.
- **The handoff is the interaction target** — each handoff on the timeline expands in place to its
  evidence: the frozen payload beside each carried concept's *current* node with a computed drift
  verdict, and the return note (or the open loop's ghost). Lineage is one tree; a pending handoff
  hangs a dashed "expected return" ghost branch off what it carries.
- **Browse & filter** — faceted filters by type/status/surface and a plain substring search (`?q=`).
- **Write actions** — comment (an `annotates` fork), fork, and open/return a handoff straight from a
  card. A comment is a fork, never an edit, so concept immutability still holds; the static snapshot
  stays form-free.

## Scope (v1)

Deliberately small. **Not** included: full-text/semantic recall, auth/multi-user/teams, cloud/sync,
automatic cross-reference discovery, graph-visualization libraries, or orchestration. See `CLAUDE.md`
for the full architecture and scope fence.

## How to connect

headwater is a **stdio** MCP server launched with `bun run`. Point your client at the entry file by
**absolute path** (so it works regardless of the client's working directory). The pool lives at
`~/.workspace/pool.db` no matter where the server is started; set `HEADWATER_DATA_DIR` to relocate it.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "headwater": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/headwater/src/index.ts"]
    }
  }
}
```

Replace `/absolute/path/to/headwater` with the absolute path to your clone. On Windows, use an escaped
absolute path, e.g. `"args": ["run", "C:\\Users\\you\\headwater\\src\\index.ts"]`. To relocate the pool,
add `"env": { "HEADWATER_DATA_DIR": "/custom/path" }`. Restart Claude Desktop to pick up the change.

### Claude Code

Add it from the repo root with the CLI (the `--` separates headwater's launch command):

```sh
claude mcp add headwater -- bun run /absolute/path/to/headwater/src/index.ts
```

Replace `/absolute/path/to/headwater` with the absolute path to your clone (a Windows absolute path on
Windows). Equivalently, commit a project-scoped `.mcp.json` with the same shape as the Claude Desktop
snippet above. Override the pool location with `--env HEADWATER_DATA_DIR=/custom/path`. Verify with
`claude mcp list`.

> For local development from the repo root, `bun run start` launches the same server.

### Regenerate the observation page

```sh
bun run render   # reads the pool and (re)writes ./index.html — open it in a browser
```

## Security

headwater is **local-first and single-user**. The live viewer binds to **`127.0.0.1`** only and is
**unauthenticated by design** in v1 — it is meant for the operator on their own machine, not a shared
host or the network. With that boundary:

- Concept bodies render **escape-first**: text is HTML-escaped first, then a fixed whitelist of tags is
  reintroduced. Images and links are accepted only with `http(s)` URLs — no raw HTML, `javascript:`, or
  `data:` URLs reach the page, and the vendored Mermaid runs with `securityLevel: 'strict'`.
- Write actions are `POST`-only with a 303 redirect (a refresh never re-submits). The viewer answers
  **only loopback Hosts** (a DNS-rebinding defense), and a cross-site `POST` is additionally rejected via
  `Sec-Fetch-Site`.
- **Immutability is enforced at the substrate**: SQLite triggers reject any `UPDATE`/`DELETE` that would
  rewrite a concept, a lineage edge, or a handoff's frozen fields — so tampering fails even outside the
  tools.
- The pool lives outside the repo and all SQLite files are git-ignored, so data never lands in version
  control.

Do **not** expose the viewer to an untrusted network or multiple users — auth/multi-user/cloud is
explicitly out of v1 scope. See `CLAUDE.md` for the full posture.

## License

MIT © 2026 YKnowMe
