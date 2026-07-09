# CLAUDE.md — headwater

Local-first tool that records and makes observable the **handoff of state between AI surfaces**
(a Claude Desktop chat, a Claude Code session, other agents). Memory tools remember *what was
learned*; headwater models *how it moves*. This is v1: the smallest thing that closes one real loop.

## Locked stack — no deviations
- **TypeScript, run with Bun.** Bun is the package manager AND the runtime. Run with `bun run`; no build step.
- **Only two runtime deps:** `@modelcontextprotocol/sdk` (MCP server) and `zod` (tool input schemas).
- Use Bun built-ins for everything else: `bun:sqlite` (the pool), `bun:test` (tests), `Bun.write` +
  template literals (static HTML). No web framework, no ORM, no extra libraries.
- **Carve-out (deliberate, operator-approved — see the superseding concept in the pool):** the live
  `bun run serve` viewer renders rich concept bodies — a fixed escape-first markdown subset (images via
  `http(s)` URLs, pipe-tables, bold/italic/`code`/links, flat bullet/numbered lists, `- [ ]`/`- [x]`
  checklists, `[[concept-id]]` wikilinks resolved against the whole pool) parsed server-side, and
  `` ```mermaid `` diagram blocks rendered **client-side** by a **vendored** Mermaid bundle (`vendor/mermaid.min.js`,
  `securityLevel: 'strict'`, **live-viewer only**). This is the single allowed exception to "no client JS /
  no graph-viz library". The two Bun runtime deps are unchanged — Mermaid is a vendored static asset served
  to the browser, not a server/runtime import. The static `bun run render` file stays pure HTML/CSS and
  shows `` ```mermaid `` as a code block.

## Layout (closed file list — do not add source files)
- `src/db.ts` — schema, idempotent init/connection (`bun:sqlite`), data-dir resolution, id/slug/time helpers.
- `src/server.ts` — the six MCP tools. Tool logic lives here as exported functions (testable without MCP);
  `startServer()` wires them into an `McpServer` over a stdio transport.
- `src/render.ts` — reads `pool.db` and writes a static `index.html` via `Bun.write` (`bun run render`).
  Also `bun run serve`: a tiny `Bun.serve` viewer (a runtime built-in, not a web framework) that re-renders
  the page from the pool on every request; in that live mode the page carries one vanilla-JS Refresh button
  (`location.reload()`) — no framework. The static `bun run render` output is **read-only** (only SELECTs,
  no forms). The **live viewer adds a write surface**: native `<form>` POST actions — comment (an
  `annotates` fork), fork, and open/return handoff — that submit to same-origin `/w/*` routes, call the
  existing `src/server.ts` tool functions, and `303`-redirect (PRG, so a refresh never re-submits). GET only
  ever renders; only POST writes; forms render **live-only** (the static file stays form-free). A "comment"
  is `fork_concept` with `kind='annotates'` — **never** an `UPDATE`, so concept immutability holds. The
  server binds to **`127.0.0.1`**: unauthenticated localhost is the deliberate v1 posture (a
  `Sec-Fetch-Site: cross-site` POST is refused as cheap, dependency-free defense-in-depth — not auth;
  residual same-machine CSRF is accepted for v1), and answers **only loopback Hosts** (a DNS-rebinding
  defense — a rebound page is same-origin but its Host header is foreign). In the live viewer, concept bodies render the escape-first
  markdown subset + `` ```mermaid `` blocks per the Locked-stack carve-out (the static file shows
  `` ```mermaid `` source as a code block). The live viewer also honors **read-only** query-param filters
  (`?project=`/`?type=`/`?status=`/`?surface=`/`?q=`; `q` is a plain SQL `LIKE` substring — not FTS) via a
  live-only filter bar + GET search form; the static file is the unfiltered snapshot.
  **Canonical representations (settled design — do not re-add variants):** lineage renders as ONE tree and
  handoffs as ONE vertical spine timeline; the old cards/table/SVG and tree/diagram/table switches were
  deliberately pruned. Each handoff expands in place (native `<details>`) to its evidence — frozen
  `payload_snapshot` panes beside each carried concept's current node with a computed drift verdict, plus
  the return note. Ghost grammar (dashed + italic + hollow) marks expected-but-not-present: a pending
  handoff's terminus, its expected-return branch in the tree, and dangling `[[wikilinks]]`. Wikilink/drift
  resolution is always whole-pool, never the current filter.
- `src/index.ts` — entry point; calls `startServer()`.
- `tests/loop.test.ts` — `bun:test` end-to-end smoke test of the full loop against a temp DB.
- `vendor/mermaid.min.js` — the self-contained Mermaid **v11.15.0** UMD bundle (a vendored static asset,
  **not** an npm dep; MIT, notice in `vendor/mermaid.LICENSE`), served by the live viewer to render diagram
  blocks offline. The only vendored asset; do not add others without a recorded decision.
- `scripts/backup.ts` — `bun run backup`: snapshot the pool with `VACUUM INTO` over a **read-only**
  connection (a plain `cp` loses un-checkpointed WAL commits and the copy still passes
  `integrity_check`), verify it (`integrity_check` + a monotonic row-count tripwire — the append-only
  tables can never shrink), then publish timestamped copies to `<data dir>/backups/` and to
  `$HEADWATER_BACKUP_DIR` (default `~/OneDrive/headwater-backups/`), pruning both to the newest 14.
  Any failure publishes nothing new and prunes nothing. A recorded, operator-approved addition;
  `tests/backup.test.ts` covers it. **Restore is a documented manual procedure (README) — never
  scripted**, because its dangerous step (stop every writer) is one no script can verify.

## Data — one authoritative SQLite pool
- Lives **outside the repo**: `~/.workspace/pool.db` by default, override with `HEADWATER_DATA_DIR`.
- Six tables: `project`, `surface`, `concept`, `lineage`, `handoff`, `handoff_concept`.
- **Invariants (enforce, never violate):**
  - **Concepts are immutable.** Never `UPDATE` a concept. A fork is a NEW row + a lineage edge.
  - **Lineage is append-only.** Edges go from child (`from_concept_id`) → parent (`to_concept_id`).
    The original is the canonical root; branches hang off it. The original is never touched by a fork.
  - **Handoff `payload_snapshot` and `directive` are frozen at creation.** Only `status`/`returned_at`/
    `return_note` move in place (`pending → returned` in v1).
  - IDs are stable slugs; timestamps are ISO `TEXT`.
  - **Enforced at the substrate (schema v2).** `BEFORE UPDATE/DELETE` triggers reject any write that
    violates the above — concept immutable, lineage + `handoff_concept` append-only, handoff frozen except
    the return transition — so a raw `sqlite3` edit fails too, not just the tool paths. Operator data
    surgery must drop the relevant trigger first (and is itself a recorded, deliberate act).

## The six MCP tools
- `write_concept(project, type, title, body, status="active", surface)` → new immutable concept.
- `fork_concept(parent_id, body, surface, kind="forks_from", reason=None, type="note", title=None)`
  → new concept (same project as parent) + a lineage edge new→parent. Original untouched.
- `read_concept(id)` → the concept node (recall-by-id is first-class).
- `read_project_state(project)` → kickoff context: concepts grouped by status, pending handoffs, recents.
  Bodies arrive as bounded `body_preview`s (the kickoff is a map, not the archive); `read_concept` recalls
  the full text — this applies to frozen snapshot concepts inside handoffs too (presentation only; stored
  rows and snapshots stay whole). Grouping is by **effective** status: closure is **derived from lineage,
  never stored** (a `supersedes` child closes any concept; a `decision` child via forks_from/evolved_from/
  supersedes answers an `open_question`; annotates/relates_to/depends_on never close) — a derived-closed
  concept presents under `resolved` with `closed_by`, its stored status untouched. The viewer groups and
  badges the same way. Do not add a status-update path; this is the settled alternative.
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
cross-reference discovery, no design-tool surface, no orchestration. No speculative abstractions or plugin
layers. No graph-viz library — **except** the one recorded carve-out above (a vendored, live-viewer-only,
`strict` Mermaid for diagrams embedded in concept bodies).

## Run
- `bun run start` — MCP server (stdio). `bun run render` — write `index.html`. `bun run serve` — live viewer
  with a Refresh button. `bun run backup` — verified pool snapshot → local history + offsite. `bun test` — tests.
- stdio is the MCP channel: never write to **stdout** from the server; logs go to **stderr**.
