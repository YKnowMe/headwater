# CLAUDE.md — headwater

Local-first tool that records and makes observable the **handoff of state between AI surfaces**
(a Claude Desktop chat, a Claude Code session, other agents). Memory tools remember *what was
learned*; headwater models *how it moves*. This is v1: the smallest thing that closes one real loop.

## Locked stack — no deviations
- **TypeScript, run with Bun.** Bun is the package manager AND the runtime. Run with `bun run`; no build step.
- **Only two runtime deps:** `@modelcontextprotocol/sdk` (MCP server) and `zod` (tool input schemas).
- Use Bun built-ins for everything else: `bun:sqlite` (the pool), `bun:test` (tests), `Bun.write` +
  template literals (static HTML). No web framework, no ORM, no extra libraries.

## Layout (closed file list — do not add source files)
- `src/db.ts` — schema, idempotent init/connection (`bun:sqlite`), data-dir resolution, id/slug/time helpers.
- `src/server.ts` — the six MCP tools. Tool logic lives here as exported functions (testable without MCP);
  `startServer()` wires them into an `McpServer` over a stdio transport.
- `src/render.ts` — reads `pool.db`, writes a single static `index.html` via `Bun.write`. Read-only.
- `src/index.ts` — entry point; calls `startServer()`.
- `tests/loop.test.ts` — `bun:test` end-to-end smoke test of the full loop against a temp DB.

## Data — one authoritative SQLite pool
- Lives **outside the repo**: `~/.workspace/pool.db` by default, override with `HANDOFF_DATA_DIR`.
- Six tables: `project`, `surface`, `concept`, `lineage`, `handoff`, `handoff_concept`.
- **Invariants (enforce, never violate):**
  - **Concepts are immutable.** Never `UPDATE` a concept. A fork is a NEW row + a lineage edge.
  - **Lineage is append-only.** Edges go from child (`from_concept_id`) → parent (`to_concept_id`).
    The original is the canonical root; branches hang off it. The original is never touched by a fork.
  - **Handoff `payload_snapshot` and `directive` are frozen at creation.** Only `status`/`returned_at`/
    `return_note` move in place (`pending → returned` in v1).
  - IDs are stable slugs; timestamps are ISO `TEXT`.

## The six MCP tools
- `write_concept(project, type, title, body, status="active", surface)` → new immutable concept.
- `fork_concept(parent_id, body, surface, kind="forks_from", reason=None, type="note", title=None)`
  → new concept (same project as parent) + a lineage edge new→parent. Original untouched.
- `read_concept(id)` → the concept node (recall-by-id is first-class).
- `read_project_state(project)` → kickoff context: concepts grouped by status, pending handoffs, recents.
- `open_handoff(project, from_surface, to_surface, concept_ids, directive)` → `pending` handoff with a
  frozen JSON `payload_snapshot` of the named concepts + `handoff_concept` join rows.
- `return_handoff(handoff_id, return_note)` → `status=returned`, `returned_at=now`, `return_note`.

## v1 simplifications (documented on purpose; revisit later, do not "fix" silently)
- Every write tool takes a `surface` (id or label) identifying the caller; the server upserts it into the
  surface registry. Per-connection identity comes later.
- `project` and `surface` are **upserted on first mention**: project `id = slug(name)`, `repo_path` empty;
  an upserted surface gets default `kind = "external_agent"` (no tool carries kind/repo_path in v1).
- `handoff` statuses `consumed`/`dropped` and most `lineage.kind`/`reason` values exist in the schema but
  are not yet driven by a tool. That's intentional headroom, not dead code to remove.

## Scope fence — do NOT build (ask first if you think something is genuinely missing)
No FTS, no vector/semantic recall, no reranking. No auth, multi-user, teams, cloud, or sync. No automatic
cross-reference discovery, no graph-viz library, no design-tool surface, no orchestration. No speculative
abstractions or plugin layers.

## Run
- `bun run start` — start the MCP server (stdio). `bun run render` — regenerate `index.html`. `bun test` — tests.
- stdio is the MCP channel: never write to **stdout** from the server; logs go to **stderr**.
