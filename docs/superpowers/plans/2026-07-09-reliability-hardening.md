# Reliability Hardening (Spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `return_handoff` retry-safe (a retry can currently destroy the stored return note), cut the `read_project_state` payload ~31%, and instrument every tool call — per the spec at `docs/superpowers/specs/2026-07-09-reliability-hardening-design.md` (commit `94b23a3`).

**Architecture:** Four layers, inside the existing two source files. (1) A schema-v3 trigger makes the handoff transition `pending → returned` one-way at the substrate; `returnHandoff` short-circuits before the `UPDATE` with idempotent-if-identical / conflict-if-different semantics. (2) `readProjectState` dedupes pending handoffs out of `recent_handoffs`, previews archive directives/notes, and shrinks snapshots and `recent_concepts` to heads; the mutation tools return slim confirmations. (3) A new exported `callTool(db, op, args)` dispatcher owns the try/catch, the total-size degrade guard, and one JSONL log line per call — `registerTools` wires each MCP tool to it, giving tests a seam that exercises the exact wire path without MCP plumbing. (4) A 10×-scale fixture plus a real spawned-server soak reproduces (or honestly fails to reproduce) the wedge pattern.

**Tech Stack:** TypeScript on Bun. `bun:sqlite`, `node:fs`, `node:path` — built-ins only. `bun:test`.

## Global Constraints

- **No new runtime dependencies.** The two runtime deps stay `@modelcontextprotocol/sdk` and `zod`.
- **No new tools, no new source files.** Six MCP tools, unchanged names/argument schemas. Only `tests/reliability.test.ts` is a new file.
- **Never `UPDATE` a concept; lineage is append-only** — untouched by this work.
- **Diagnostics never go to stdout.** stdout is the MCP channel. The new per-request log goes to a FILE (`<data dir>/headwater.log`), NOT stderr — logging every request to an undrained stderr pipe would create the wedge this spec hunts.
- **Logging must never throw and never fail a request** — wrap in try/catch and swallow.
- **The size guard degrades; it never errors.** Default cap `131072` bytes, override `HEADWATER_MAX_RESPONSE_BYTES`.
- **Preview length is the existing `PREVIEW_CHARS` (280)** — reuse it, do not invent a second constant.
- "Identical note" means **exact string equality** on `return_note`. No normalisation.
- **Windows is the target platform**: `db.close()` before deleting temp dirs in tests (see `tests/loop.test.ts:33`).
- **Never test against the live pool** (`~/.workspace/pool.db`). Temp pools only; the one live-pool step in Task 4 is read-only and runs against a scratchpad COPY.
- Back-compat (spec §Back-compatibility): exported function signatures unchanged. `returnHandoff`'s return type widens additively to `HandoffRow & { already_returned?: boolean }` — every existing caller (`src/render.ts:1160`, `scripts/seed-demo.ts:149`, `tests/loop.test.ts:124`) treats it as `HandoffRow` and keeps working.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/db.ts` | **Modify.** `SCHEMA_VERSION` 2 → 3; `handoff_return_is_one_way` trigger in `schemaSql()`. |
| `src/server.ts` | **Modify.** `returnHandoff` guard; `previewText`/`presentHandoffArchive`/`confirmHandoff`/`degradeProjectState` helpers; `readProjectState` shape; `callTool` dispatcher + `logCall`; `registerTools` wiring. |
| `tests/reliability.test.ts` | **Create.** Retry safety, substrate triggers, state shape, degrade guard, logging, 10× scale, spawned-server soak. |
| `tests/loop.test.ts` | **Modify.** One assertion (line 923) moves to the new shape. |
| `CLAUDE.md`, `README.md` | **Modify** (Task 4). One-way invariant, log file, size guard. |

---

### Task 1: Write-path safety — idempotent `returnHandoff` + schema-v3 one-way trigger

The emergency. A retried `return_handoff` currently overwrites the stored note silently (verified against a pool copy: a retry replaced ThreadKey's 1,563-byte Round 5 note and returned exit 0).

**Files:**
- Modify: `src/db.ts:217-220` (version comment + `SCHEMA_VERSION`), `src/db.ts:198-211` (trigger block in `schemaSql()`)
- Modify: `src/server.ts:342-350` (`returnHandoff`)
- Create: `tests/reliability.test.ts`

**Interfaces:**
- Consumes: `getHandoff` (private, `src/server.ts:118`), `nowIso` from `./db.ts`.
- Produces: `returnHandoff(db, args): HandoffRow & { already_returned?: boolean }` — later tasks and existing callers rely on the `HandoffRow` part; the MCP layer (Task 2) reads `already_returned`.

- [ ] **Step 1: Write the failing tests**

Create `tests/reliability.test.ts`:

```ts
// reliability.test.ts — Spec A hardening (docs/superpowers/specs/2026-07-09-reliability-hardening-design.md).
// The load-bearing property: no retry of return_handoff can ever destroy a stored return note —
// enforced in the tool (idempotent-if-identical, conflict-if-different) AND at the substrate
// (schema-v3 trigger: the only handoff transition that exists is pending -> returned).
// Everything runs against throwaway pools; the operator's real pool is never opened.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.ts";
import { writeConcept, openHandoff, returnHandoff } from "../src/server.ts";
import type { HandoffRow } from "../src/db.ts";

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "headwater-rel-"));
  db = initDb(join(tempDir, "pool.db"));
});

afterEach(() => {
  db.close(); // release the handle before deleting (Windows locks open files)
  rmSync(tempDir, { recursive: true, force: true });
});

/** One concept + one pending handoff carrying it. */
function seedHandoff(note?: { directive?: string }): HandoffRow {
  const c = writeConcept(db, {
    project: "rel-test",
    type: "note",
    title: "carried",
    body: "cargo",
    surface: "test:rel",
  });
  return openHandoff(db, {
    project: "rel-test",
    from_surface: "test:a",
    to_surface: "test:b",
    concept_ids: [c.id],
    directive: note?.directive ?? "do the thing",
  });
}

// --- retry safety: the regression tests for the data-loss bug -------------------------------

test("first return works exactly as before", () => {
  const h = seedHandoff();
  const r = returnHandoff(db, { handoff_id: h.id, return_note: "done" });
  expect(r.status).toBe("returned");
  expect(r.return_note).toBe("done");
  expect(r.already_returned).toBeUndefined();
});

test("retry with an IDENTICAL note is a no-op: nothing stored changes, already_returned flags it", () => {
  const h = seedHandoff();
  const first = returnHandoff(db, { handoff_id: h.id, return_note: "done" });

  const retry = returnHandoff(db, { handoff_id: h.id, return_note: "done" });
  expect(retry.already_returned).toBe(true);
  expect(retry.return_note).toBe("done");
  expect(retry.returned_at).toBe(first.returned_at); // timestamp did NOT move — no UPDATE happened

  const stored = db.query<HandoffRow, [string]>(`SELECT * FROM handoff WHERE id = ?`).get(h.id)!;
  expect(stored.return_note).toBe("done");
  expect(stored.returned_at).toBe(first.returned_at);
});

test("retry with a DIFFERENT note is refused and the stored note survives — the data-loss regression", () => {
  const h = seedHandoff();
  const first = returnHandoff(db, { handoff_id: h.id, return_note: "the real Round 5 note" });

  expect(() => returnHandoff(db, { handoff_id: h.id, return_note: "a drifted retry" })).toThrow(
    /already returned at .* with a different note; refusing to overwrite/,
  );
  // the conflict message names the stored timestamp so a stuck client knows its write landed
  try {
    returnHandoff(db, { handoff_id: h.id, return_note: "a drifted retry" });
  } catch (err) {
    expect((err as Error).message).toContain(first.returned_at!);
  }

  const stored = db.query<HandoffRow, [string]>(`SELECT * FROM handoff WHERE id = ?`).get(h.id)!;
  expect(stored.return_note).toBe("the real Round 5 note");
  expect(stored.returned_at).toBe(first.returned_at);
});

test("unknown handoff still throws", () => {
  expect(() => returnHandoff(db, { handoff_id: "no-such", return_note: "x" })).toThrow(/unknown handoff/);
});

// --- substrate: the one-way trigger holds even against raw SQL ------------------------------

test("substrate refuses returned -> returned even via raw SQL", () => {
  const h = seedHandoff();
  returnHandoff(db, { handoff_id: h.id, return_note: "first" });
  expect(() =>
    db
      .query(`UPDATE handoff SET status = 'returned', returned_at = ?, return_note = ? WHERE id = ?`)
      .run("2099-01-01T00:00:00.000Z", "clobber attempt", h.id),
  ).toThrow(/one-way/);
});

test("substrate refuses pending -> pending and pending -> consumed", () => {
  const h = seedHandoff();
  expect(() =>
    db.query(`UPDATE handoff SET status = 'pending', return_note = 'sneak' WHERE id = ?`).run(h.id),
  ).toThrow(/one-way/);
  expect(() =>
    db.query(`UPDATE handoff SET status = 'consumed' WHERE id = ?`).run(h.id),
  ).toThrow(/one-way/);
});

test("pending -> returned still works at the substrate (the existing loop must not break)", () => {
  const h = seedHandoff();
  db.query(`UPDATE handoff SET status = 'returned', returned_at = ?, return_note = ? WHERE id = ?`).run(
    "2026-07-09T00:00:00.000Z",
    "raw but legal",
    h.id,
  );
  const stored = db.query<HandoffRow, [string]>(`SELECT * FROM handoff WHERE id = ?`).get(h.id)!;
  expect(stored.status).toBe("returned");
});

test("an existing v2 pool gains the trigger on next open (version gate re-runs the DDL)", () => {
  // Simulate a pre-upgrade pool: same schema, user_version forced back to 2, trigger dropped.
  const path = join(tempDir, "v2.db");
  const v2 = initDb(path);
  v2.exec(`DROP TRIGGER IF EXISTS handoff_return_is_one_way;`);
  v2.exec(`PRAGMA user_version = 2;`);
  v2.close();

  const reopened = initDb(path); // ensureSchema sees 2 < 3, re-runs the IF NOT EXISTS batch
  const trig = reopened
    .query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
    .get("handoff_return_is_one_way");
  expect(trig?.name).toBe("handoff_return_is_one_way");
  reopened.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/reliability.test.ts`
Expected: FAIL — the clobber tests fail because the retry currently *succeeds* (overwrites), and the trigger tests fail because raw `returned → returned` currently succeeds. The v2-upgrade test fails with `DROP TRIGGER ... no such trigger` skipped — it fails on the final expect (trigger absent). If instead it errors on the DROP line, that is also a valid RED (trigger doesn't exist yet).

- [ ] **Step 3: Add the trigger and bump the schema version**

In `src/db.ts`, append inside `schemaSql()`'s template literal, directly after the `handoff_no_delete` trigger block (after line 211, before the closing backtick):

```sql
    -- v3: the only status transition that exists is pending -> returned, enforced here so even a
    -- raw sqlite3 edit cannot clobber a stored return (a retried return_handoff nearly erased a
    -- client's return note — the tool now short-circuits, this is the backstop). Revising this
    -- trigger to admit 'consumed'/'dropped' is a recorded, deliberate act, like all data surgery.
    CREATE TRIGGER IF NOT EXISTS handoff_return_is_one_way
      BEFORE UPDATE ON handoff
      WHEN OLD.status <> 'pending' OR NEW.status <> 'returned'
      BEGIN SELECT RAISE(ABORT, 'handoff return is one-way: only pending -> returned'); END;
```

Replace the version comment and constant at `src/db.ts:217-220`:

```ts
/** Bump when the schema changes. Gates one-time DDL via PRAGMA user_version. v2 added the immutability
 *  triggers; v3 adds handoff_return_is_one_way. Because schemaSql() uses IF NOT EXISTS throughout, an
 *  existing older pool gains the new objects on its next open (re-running the DDL is a no-op for
 *  everything that already exists). */
const SCHEMA_VERSION = 3;
```

- [ ] **Step 4: Guard `returnHandoff`**

Replace `src/server.ts:342-350` with:

```ts
/**
 * Move a handoff to `returned`, stamping returned_at and the return note. Retry-safe: a repeat call
 * with the IDENTICAL note is a no-op returning the stored row (flagged already_returned) — no UPDATE
 * is issued; a repeat with a DIFFERENT note is refused, naming the stored returned_at so a client
 * that never saw its first response knows the write landed. The schema-v3 trigger backstops this at
 * the substrate. Never overwrite: a retry after a hang was silently erasing the stored note.
 */
export function returnHandoff(
  db: Database,
  args: ReturnHandoffArgs,
): HandoffRow & { already_returned?: boolean } {
  const existing = getHandoff(db, args.handoff_id);
  if (!existing) throw new Error(`unknown handoff: ${args.handoff_id}`);
  if (existing.status !== "pending") {
    if (existing.return_note === args.return_note) return { ...existing, already_returned: true };
    throw new Error(
      `handoff ${args.handoff_id} was already returned at ${existing.returned_at} with a different note; ` +
        `refusing to overwrite. The earlier return stands. If this note adds something, record it as a concept instead.`,
    );
  }
  db.query(
    `UPDATE handoff SET status = 'returned', returned_at = ?, return_note = ? WHERE id = ?`,
  ).run(nowIso(), args.return_note, args.handoff_id);
  return getHandoff(db, args.handoff_id)!;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/reliability.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: everything passes (98 total: 90 existing + 8 new). `tests/loop.test.ts` still passes — the double-return test at `loop.test.ts:157` uses an *unknown* id (unchanged path), and the viewer's return-form path (`src/render.ts:1160`) only runs on pending handoffs.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/server.ts tests/reliability.test.ts
git commit -m "fix(server): a retried return_handoff can no longer destroy the stored note

returnHandoff was a bare UPDATE with no status guard, and the frozen-fields
trigger does not constrain status — so the natural recovery action after a
hung call (retry) silently overwrote the return note it was confirming.
Now: identical note -> no-op flagged already_returned; different note ->
refused, naming the stored returned_at so the caller knows its write
landed. Schema v3 backstops it at the substrate: the only transition that
exists is pending -> returned, even for raw sqlite3."
```

---

### Task 2: State-shape slimming + slim mutation confirmations

Cuts `read_project_state("threadkey")` from 105.9 KB to ~73 KB. Pending handoffs keep their whole `directive` (actionable); returned handoffs become archive previews; `recent_concepts` (100% duplicated in `concepts_by_status`) become heads; mutation tools stop echoing 10 KB frozen snapshots.

**Files:**
- Modify: `src/server.ts` — `summarize` (:138), `presentHandoffPreview` (:176), `readProjectState` (:277-301), `ProjectState` type (:82-90); add `previewText`, `presentHandoffArchive`, `confirmHandoff`, `ConceptHead`
- Modify: `src/server.ts:465-506` — the `open_handoff` / `return_handoff` wiring (`presentHandoff(...)` → `confirmHandoff(...)`)
- Modify: `tests/loop.test.ts:919-925`
- Test: `tests/reliability.test.ts`

**Interfaces:**
- Consumes: `returnHandoff` from Task 1 (reads `already_returned`); existing `PREVIEW_CHARS`, `summarize`, `presentHandoff`.
- Produces (later tasks rely on these exact names):
  - `previewText(s: string): string` — flatten whitespace, truncate at `PREVIEW_CHARS` with `…`.
  - `presentHandoffArchive(row: HandoffRow): Record<string, unknown>` — archive shape: no `directive`/`return_note`; `directive_preview`, `return_note_preview`, `payload_snapshot: Array<{id, title}>`.
  - `confirmHandoff(row: HandoffRow & { already_returned?: boolean }): Record<string, unknown>` — `{id, project_id, from_surface_id, to_surface_id, status, initiated_at, returned_at, concept_ids, already_returned?}`.
  - `export type ConceptHead = Pick<ConceptRow, "id" | "type" | "title" | "status" | "created_at"> & { closed_by?: ClosedBy }`.
  - `ProjectState.recent_concepts: ConceptHead[]` (was `ConceptSummary[]`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/reliability.test.ts`. Extend the `../src/server.ts` import with `readProjectState, confirmHandoff, presentHandoffArchive`:

```ts
// --- state shape: dedupe + archive previews + heads ------------------------------------------

test("recent_handoffs excludes pending handoffs (they live in open_handoffs, once)", () => {
  const h = seedHandoff();
  const state = readProjectState(db, "rel-test");
  expect(state.open_handoffs).toHaveLength(1);
  expect(state.recent_handoffs).toHaveLength(0); // pending is NOT duplicated here

  returnHandoff(db, { handoff_id: h.id, return_note: "closed" });
  const after = readProjectState(db, "rel-test");
  expect(after.open_handoffs).toHaveLength(0);
  expect(after.recent_handoffs).toHaveLength(1);
});

test("a pending handoff keeps its WHOLE directive; a returned one carries previews only", () => {
  const longDirective = "directive-head " + "d".repeat(2000) + " directive-tail";
  const h = seedHandoff({ directive: longDirective });

  const pendingState = readProjectState(db, "rel-test");
  const open = pendingState.open_handoffs[0]! as Record<string, unknown>;
  expect(open.directive).toBe(longDirective); // the actionable payload arrives whole

  const longNote = "note-head " + "n".repeat(2000) + " note-tail";
  returnHandoff(db, { handoff_id: h.id, return_note: longNote });
  const returnedState = readProjectState(db, "rel-test");
  const arch = returnedState.recent_handoffs[0]! as Record<string, unknown>;
  expect("directive" in arch).toBe(false);
  expect("return_note" in arch).toBe(false);
  expect((arch.directive_preview as string).startsWith("directive-head")).toBe(true);
  expect((arch.directive_preview as string).length).toBeLessThanOrEqual(281); // 280 + ellipsis
  expect((arch.return_note_preview as string).startsWith("note-head")).toBe(true);
  expect(JSON.stringify(arch)).not.toContain("directive-tail");
  expect(JSON.stringify(arch)).not.toContain("note-tail");
});

test("an archived handoff's payload_snapshot is ids+titles only", () => {
  const h = seedHandoff();
  returnHandoff(db, { handoff_id: h.id, return_note: "closed" });
  const state = readProjectState(db, "rel-test");
  const snap = (state.recent_handoffs[0]! as Record<string, unknown>).payload_snapshot as Array<
    Record<string, unknown>
  >;
  expect(snap).toHaveLength(1);
  expect(Object.keys(snap[0]!).sort()).toEqual(["id", "title"]);
  expect(snap[0]!.title).toBe("carried");
});

test("recent_concepts are heads: no body_preview (every entry is already in concepts_by_status)", () => {
  writeConcept(db, {
    project: "rel-test",
    type: "note",
    title: "T",
    body: "some body text",
    surface: "test:rel",
  });
  const state = readProjectState(db, "rel-test");
  const rc = state.recent_concepts[0]! as Record<string, unknown>;
  expect(rc.id).toBeDefined();
  expect(rc.title).toBe("T");
  expect("body_preview" in rc).toBe(false);
  expect("body" in rc).toBe(false);
  // the full-summary form still exists exactly once, in concepts_by_status
  expect(state.concepts_by_status.active.some((c) => c.title === "T" && "body_preview" in c)).toBe(true);
});

// --- mutation confirmations: no more echoing the frozen snapshot back at the caller ----------

test("confirmHandoff is a slim confirmation: concept ids, no directive, no snapshot bodies", () => {
  const h = seedHandoff({ directive: "a long directive the caller already has" });
  const conf = confirmHandoff(h);
  expect(conf.id).toBe(h.id);
  expect(conf.status).toBe("pending");
  expect(Array.isArray(conf.concept_ids)).toBe(true);
  expect((conf.concept_ids as string[]).length).toBe(1);
  expect("directive" in conf).toBe(false);
  expect("payload_snapshot" in conf).toBe(false);
  expect("already_returned" in conf).toBe(false); // only present when true

  const r = returnHandoff(db, { handoff_id: h.id, return_note: "done" });
  const retry = returnHandoff(db, { handoff_id: h.id, return_note: "done" });
  expect(confirmHandoff(retry).already_returned).toBe(true);
  expect(confirmHandoff(r).returned_at).toBe(r.returned_at);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/reliability.test.ts`
Expected: FAIL — import error on `confirmHandoff`/`presentHandoffArchive` (not exported yet).

- [ ] **Step 3: Implement the shapes**

In `src/server.ts`:

**(a)** Extract the preview text helper and refactor `summarize` to use it. Replace lines 136-142 (`const PREVIEW_CHARS = 280;` through the end of `summarize`) with:

```ts
const PREVIEW_CHARS = 280;

/** Flatten whitespace and truncate to PREVIEW_CHARS with an ellipsis. */
function previewText(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + "…" : flat;
}

function summarize(c: ConceptRow): ConceptSummary {
  const { body, ...rest } = c;
  return { ...rest, body_preview: previewText(body) };
}
```

**(b)** Directly after `presentHandoffPreview` (after line ~185), add:

```ts
/**
 * A RETURNED handoff as the kickoff presents it: archive, not payload. The directive and return
 * note arrive as bounded previews and the frozen snapshot shrinks to ids+titles — full recall is
 * the viewer today, read_handoff when it ships (Spec B). Pending handoffs never come through here:
 * their directive is what the receiver must act on, so presentHandoffPreview keeps it whole.
 */
export function presentHandoffArchive(row: HandoffRow): Record<string, unknown> {
  let heads: Array<{ id: string; title: string }> = [];
  try {
    const snap = JSON.parse(row.payload_snapshot) as Array<{ id?: unknown; title?: unknown }>;
    if (Array.isArray(snap)) heads = snap.map((c) => ({ id: String(c.id ?? ""), title: String(c.title ?? "") }));
  } catch {
    // unparseable snapshot: present no heads rather than fail the kickoff
  }
  const { directive, return_note, payload_snapshot, ...rest } = row;
  return {
    ...rest,
    directive_preview: previewText(directive),
    return_note_preview: previewText(return_note ?? ""),
    payload_snapshot: heads,
  };
}

/**
 * Slim confirmation for the mutation tools. The caller supplied the directive and concept ids;
 * echoing the frozen 10KB snapshot back at them was pure response weight (and response size is a
 * live wedge hypothesis). already_returned appears only when true.
 */
export function confirmHandoff(row: HandoffRow & { already_returned?: boolean }): Record<string, unknown> {
  let conceptIds: string[] = [];
  try {
    const snap = JSON.parse(row.payload_snapshot) as Array<{ id?: unknown }>;
    if (Array.isArray(snap)) conceptIds = snap.map((c) => String(c.id ?? ""));
  } catch {
    // unparseable snapshot: confirm with no ids rather than fail the mutation
  }
  return {
    id: row.id,
    project_id: row.project_id,
    from_surface_id: row.from_surface_id,
    to_surface_id: row.to_surface_id,
    status: row.status,
    initiated_at: row.initiated_at,
    returned_at: row.returned_at,
    concept_ids: conceptIds,
    ...(row.already_returned ? { already_returned: true } : {}),
  };
}
```

**(c)** Add the head type next to `ConceptSummary` (`src/server.ts:76-80`):

```ts
/** A concept as recents present it: identity only — the full summary already sits in concepts_by_status. */
export type ConceptHead = Pick<ConceptRow, "id" | "type" | "title" | "status" | "created_at"> & {
  closed_by?: ClosedBy;
};
```

and change `ProjectState.recent_concepts` (line 89) from `ConceptSummary[]` to `ConceptHead[]`.

**(d)** In `readProjectState`: change the `recentHandoffs` query (line 277-281) to exclude pending —

```ts
  const recentHandoffs = db
    .query<HandoffRow, [string]>(
      `SELECT * FROM handoff WHERE project_id = ? AND status <> 'pending' ORDER BY initiated_at DESC LIMIT 10`,
    )
    .all(projectId);
```

and the return block (lines 288-301) to —

```ts
  return {
    project: projectId,
    exists: projectRow !== null,
    name: projectRow?.name ?? project,
    concepts_by_status: byStatus,
    open_handoffs: openHandoffs.map(presentHandoffPreview),
    recent_handoffs: recentHandoffs.map(presentHandoffArchive),
    recent_concepts: recentConcepts.map((c) => {
      const cb = closures.get(c.id);
      return {
        id: c.id,
        type: c.type,
        title: c.title,
        status: c.status,
        created_at: c.created_at,
        ...(cb ? { closed_by: cb } : {}),
      };
    }),
  };
```

**(e)** In the MCP wiring, replace the two `presentHandoff` calls: `src/server.ts` `open_handoff` handler `ok(presentHandoff(openHandoff(db, args)))` → `ok(confirmHandoff(openHandoff(db, args)))`, and the `return_handoff` handler `ok(presentHandoff(returnHandoff(db, args)))` → `ok(confirmHandoff(returnHandoff(db, args)))`. (`presentHandoff` remains used by `presentHandoffPreview`; do not delete it.)

- [ ] **Step 4: Update the one broken loop.test.ts assertion**

`tests/loop.test.ts:919-925` — `recent_concepts` no longer carries `body_preview`. The test's intent (short bodies survive a kickoff preview verbatim) moves to `concepts_by_status`, and the new head shape gets asserted alongside:

```ts
test("short bodies survive a kickoff preview verbatim (minus nothing)", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "big", type: "note", title: "SHORT", body: "small body", surface: "s" });
  const state = readProjectState(rdb, "big");
  expect(state.concepts_by_status.active[0]!.body_preview).toBe("small body");
  // recents are heads: identity only — the summary above is the single copy of the preview
  expect(state.recent_concepts[0]!.title).toBe("SHORT");
  expect("body_preview" in state.recent_concepts[0]!).toBe(false);
  rdb.close();
});
```

Also check `tests/loop.test.ts:136-140` still holds — it asserts `recent_handoffs` length 1 with status `returned` *after* a return, which survives (the handoff is no longer pending). Line 120's `open_handoffs` length-1 check survives. Run the suite; if any other assertion trips on the shape, update it to the shapes defined in this task — do not weaken what it asserts.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: all pass (103 = 90 existing + 13 reliability, with loop.test.ts still at its prior count).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/reliability.test.ts tests/loop.test.ts
git commit -m "feat(server): slim the state payload — dedupe pending, archive previews, head recents

read_project_state(threadkey) measured 105.9KB: pending handoffs shipped
twice (open_handoffs AND recent_handoffs), returned handoffs carried whole
directives/notes/snapshots, and every recent_concept duplicated its
concepts_by_status entry. Now: recents exclude pending; returned handoffs
carry directive_preview/return_note_preview + ids+titles snapshots; recents
are heads. A pending handoff's directive stays WHOLE — it is the payload
the receiver acts on. Mutation tools return a slim confirmation instead of
echoing the frozen snapshot. Measured ~31% cut."
```

---

### Task 3: `callTool` dispatcher — size guard (degrade, never error) + per-request JSONL log

One seam owns the wire path: try/catch, the degrade guard, and exactly one log line per call — testable without MCP plumbing.

**Files:**
- Modify: `src/server.ts` — add `maxResponseBytes`, `degradeProjectState`, `logCall`, `callTool`; rewrite the six `registerTools` handlers to one-liners; extend imports (`appendFileSync` from `node:fs`, `join` from `node:path`, `resolveDataDir` from `./db.ts`)
- Test: `tests/reliability.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-2; `resolveDataDir` from `src/db.ts`.
- Produces:
  - `callTool(db: Database, op: string, args: unknown): ToolResult` — exported; `ToolResult` stays private but its shape is `{ content: [{ type: "text", text: string }], isError?: boolean }`.
  - `degradeProjectState(state: ProjectState): Record<string, unknown>` — exported for tests.
  - Log file: `<data dir>/headwater.log`, one JSON line per call: `{ts, op, project?, ok, ms, req_bytes, resp_bytes, degraded?, error?}`.
  - Env: `HEADWATER_MAX_RESPONSE_BYTES` (default 131072), read per call so tests can flip it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/reliability.test.ts`. Extend the `../src/server.ts` import with `callTool, degradeProjectState`; add `existsSync, readFileSync` to the `node:fs` import. Add env hygiene to the hooks — in `beforeEach`, after `db = initDb(...)`:

```ts
  process.env.HEADWATER_DATA_DIR = tempDir; // callTool logs to <data dir>/headwater.log
  delete process.env.HEADWATER_MAX_RESPONSE_BYTES;
```

and in `afterEach`, before `db.close()`:

```ts
  delete process.env.HEADWATER_DATA_DIR;
  delete process.env.HEADWATER_MAX_RESPONSE_BYTES;
```

Then the tests:

```ts
// --- callTool: the wire path — degrade guard + one log line per call -------------------------

function readLogLines(): Array<Record<string, unknown>> {
  const p = join(tempDir, "headwater.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("callTool answers like the plain function and logs exactly one parseable line", () => {
  const res = callTool(db, "write_concept", {
    project: "rel-test",
    type: "note",
    title: "via dispatcher",
    body: "b",
    surface: "test:rel",
  });
  expect(res.isError).toBeUndefined();
  const echoed = JSON.parse(res.content[0]!.text) as { title: string };
  expect(echoed.title).toBe("via dispatcher");

  const lines = readLogLines();
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line.op).toBe("write_concept");
  expect(line.project).toBe("rel-test");
  expect(line.ok).toBe(true);
  expect(typeof line.ms).toBe("number");
  expect(typeof line.req_bytes).toBe("number");
  expect((line.resp_bytes as number)).toBe(res.content[0]!.text.length);
  expect("degraded" in line).toBe(false);
});

test("a failing call logs ok:false with an error field and still returns isError", () => {
  const res = callTool(db, "read_concept", { id: "no-such-concept" });
  expect(res.isError).toBe(true);
  const line = readLogLines()[0]!;
  expect(line.op).toBe("read_concept");
  expect(line.ok).toBe(false);
  expect(String(line.error)).toContain("unknown concept");
});

test("an oversized state response degrades to ids+titles+counts instead of erroring", () => {
  for (let i = 0; i < 5; i++) {
    writeConcept(db, {
      project: "rel-test",
      type: "note",
      title: `filler ${i}`,
      body: "z".repeat(500),
      surface: "test:rel",
    });
  }
  process.env.HEADWATER_MAX_RESPONSE_BYTES = "1024"; // force the cap

  const res = callTool(db, "read_project_state", { project: "rel-test" });
  expect(res.isError).toBeUndefined(); // NEVER an error — an error at the cap is a total outage
  const state = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  expect(state.degraded).toBe(true);
  expect(String(state.notice)).toContain("read_concept");
  const heads = (state.concepts_by_status as Record<string, Array<Record<string, unknown>>>).active;
  expect(heads.length).toBe(5);
  expect(Object.keys(heads[0]!).sort()).toEqual(["id", "title"]);
  expect(state.concept_counts).toEqual({ active: 5, locked: 0, parked: 0, resolved: 0, discarded: 0 });

  const line = readLogLines().at(-1)!;
  expect(line.degraded).toBe(true);
});

test("an under-cap state response has no degraded key and ships the full shape", () => {
  writeConcept(db, { project: "rel-test", type: "note", title: "small", body: "b", surface: "test:rel" });
  const res = callTool(db, "read_project_state", { project: "rel-test" });
  const state = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  expect("degraded" in state).toBe(false);
  expect(
    ((state.concepts_by_status as Record<string, Array<Record<string, unknown>>>).active[0]!)
      .body_preview,
  ).toBe("b");
});

test("a log-write failure never fails the request", () => {
  process.env.HEADWATER_DATA_DIR = join(tempDir, "pool.db"); // a FILE, so <dir>/headwater.log is unwritable
  const res = callTool(db, "read_concept", { id: "still-missing" });
  expect(res.isError).toBe(true); // the tool error, not a logging crash
  process.env.HEADWATER_DATA_DIR = tempDir;
});

test("unknown op is a clean isError, not a throw", () => {
  const res = callTool(db, "no_such_tool", {});
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain("unknown tool");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/reliability.test.ts`
Expected: FAIL — import error on `callTool` / `degradeProjectState`.

- [ ] **Step 3: Implement the dispatcher**

In `src/server.ts`:

**(a)** Extend imports: add to the existing `./db.ts` value-import list `resolveDataDir`; add at the top with the other imports:

```ts
import { appendFileSync } from "node:fs";
import { join } from "node:path";
```

**(b)** Directly after `fail()` (line ~366), add:

```ts
/** Response-size cap for read_project_state. Read per call so tests can flip the env var. */
function maxResponseBytes(): number {
  const raw = process.env.HEADWATER_MAX_RESPONSE_BYTES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : 131072;
}

/**
 * The over-cap fallback: ids + titles + per-status counts. NEVER an error — an error at the cap
 * would mean a client cannot cold-start at all, trading a heavy kickoff for no kickoff. The map
 * degrades; recall stays first-class via read_concept(id).
 */
export function degradeProjectState(state: ProjectState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const heads: Record<string, Array<{ id: string; title: string }>> = {};
  for (const [status, list] of Object.entries(state.concepts_by_status)) {
    counts[status] = list.length;
    heads[status] = list.map((c) => ({ id: c.id, title: c.title }));
  }
  return {
    project: state.project,
    exists: state.exists,
    name: state.name,
    degraded: true,
    notice:
      `response exceeded ${maxResponseBytes()} bytes; concepts and handoffs reduced to ids and titles. ` +
      `Use read_concept(id) for full text.`,
    concept_counts: counts,
    concepts_by_status: heads,
    open_handoffs: state.open_handoffs.map((h) => ({
      id: h.id,
      status: h.status,
      to_surface_id: h.to_surface_id,
    })),
    recent_handoffs: state.recent_handoffs.map((h) => ({ id: h.id, status: h.status })),
    recent_concepts: state.recent_concepts.map((c) => ({ id: c.id, title: c.title })),
  };
}

/**
 * One JSONL line per tool call, appended to <data dir>/headwater.log. A FILE, deliberately not
 * stderr: the server writes stderr exactly once (startup), and logging every request into a pipe
 * the client may never drain would fill the 64KB buffer, block console.error forever, and queue
 * every later request behind it — creating the very wedge this instrumentation exists to hunt.
 * Logging failures are swallowed: a lost log line must never fail a request.
 */
function logCall(
  fields: { op: string; project?: string; degraded?: boolean },
  args: unknown,
  result: ToolResult,
  t0: number,
): void {
  try {
    const line = JSON.stringify({
      ts: nowIso(),
      op: fields.op,
      ...(fields.project ? { project: fields.project } : {}),
      ok: !result.isError,
      ms: Math.round(performance.now() - t0),
      req_bytes: JSON.stringify(args ?? {}).length,
      resp_bytes: result.content[0]?.text.length ?? 0,
      ...(fields.degraded ? { degraded: true } : {}),
      ...(result.isError ? { error: result.content[0]?.text.slice(0, 300) } : {}),
    });
    appendFileSync(join(resolveDataDir(), "headwater.log"), line + "\n");
  } catch {
    // a lost log line never fails a request
  }
}

/**
 * The wire path for every tool: dispatch, degrade-guard (read_project_state only), one log line.
 * registerTools wires each MCP tool straight to this, so tests exercise the exact path the client
 * sees without any MCP plumbing.
 */
export function callTool(db: Database, op: string, args: unknown): ToolResult {
  const t0 = performance.now();
  let result: ToolResult;
  let project: string | undefined;
  let degraded = false;
  try {
    const a = args as never; // each case narrows via the tool functions' own arg types
    switch (op) {
      case "write_concept": {
        const row = writeConcept(db, a);
        project = row.project_id;
        result = ok(row);
        break;
      }
      case "fork_concept": {
        const row = forkConcept(db, a);
        project = row.project_id;
        result = ok(row);
        break;
      }
      case "read_concept": {
        const row = readConcept(db, (args as { id: string }).id);
        project = row.project_id;
        result = ok(row);
        break;
      }
      case "read_project_state": {
        const state = readProjectState(db, (args as { project: string }).project);
        project = state.project;
        const text = JSON.stringify(state, null, 2);
        if (text.length > maxResponseBytes()) {
          degraded = true;
          result = ok(degradeProjectState(state));
        } else {
          result = { content: [{ type: "text", text }] };
        }
        break;
      }
      case "open_handoff": {
        const row = openHandoff(db, a);
        project = row.project_id;
        result = ok(confirmHandoff(row));
        break;
      }
      case "return_handoff": {
        const row = returnHandoff(db, a);
        project = row.project_id;
        result = ok(confirmHandoff(row));
        break;
      }
      default:
        throw new Error(`unknown tool: ${op}`);
    }
  } catch (err) {
    result = fail(err);
  }
  logCall({ op, project, degraded }, args, result, t0);
  return result;
}
```

**(c)** In `registerTools`, replace each handler body. The zod `inputSchema` blocks stay byte-identical; only the `async (args) => {...}` callbacks change, each to the one-liner:

```ts
    async (args) => callTool(db, "write_concept", args),
```

(and `"fork_concept"`, `"read_concept"`, `"read_project_state"`, `"open_handoff"`, `"return_handoff"` respectively — the Task 2 `confirmHandoff` wiring from those handlers now lives inside `callTool`, so this step *replaces* Task 2's step 3(e) edits).

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: all pass (109 = 103 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/reliability.test.ts
git commit -m "feat(server): callTool dispatcher — degrade guard + one JSONL log line per call

Every tool call now flows through one exported seam that owns try/catch,
the read_project_state size cap (degrades to ids+titles+counts with a
notice, NEVER errors — an error at the cap is a total outage), and one
structured log line to <data dir>/headwater.log: op, project, ok, ms,
req/resp bytes, degraded, error. A file and not stderr on purpose: logging
every request into a pipe the client never drains would manufacture the
exact wedge this instrumentation hunts. Log failures are swallowed."
```

---

### Task 4: 10× scale + spawned-server wedge soak + docs

The honest part: try to reproduce wedge #2 against a real spawned server speaking real stdio, at 10× scale, and report either way. Then document what shipped.

**Files:**
- Test: `tests/reliability.test.ts`
- Modify: `CLAUDE.md` (invariants, tool description, Run section), `README.md` (log + size guard)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-3; `src/index.ts` (the stdio entry point, spawned as-is).
- Produces: no new code exports. Documentation of: the one-way invariant, `headwater.log`, `HEADWATER_MAX_RESPONSE_BYTES`, the archive-preview state shape.

- [ ] **Step 1: Write the scale + soak tests**

Append to `tests/reliability.test.ts`:

```ts
// --- 10x scale + the wedge pattern over REAL stdio -------------------------------------------
// Wedge #2 (2026-07-09): a successful ~106KB read_project_state, then the immediately following
// return_handoff hung past the client relay's 4-minute timeout — mechanism undiagnosed. In-process
// calls cannot exercise the transport, so this spawns the actual server (src/index.ts) and speaks
// newline-delimited JSON-RPC over its real stdin/stdout, at ~10x today's scale.

const TEN_X = { concepts: 600, handoffs: 50, directiveBytes: 5_000 };

function seedTenX(dbx: Database): string[] {
  const ids: string[] = [];
  for (let i = 0; i < TEN_X.concepts; i++) {
    ids.push(
      writeConcept(dbx, {
        project: "scale",
        type: "note",
        title: `concept ${i}`,
        body: `body ${i} ` + "x".repeat(600),
        surface: "test:scale",
      }).id,
    );
  }
  for (let i = 0; i < TEN_X.handoffs; i++) {
    const h = openHandoff(dbx, {
      project: "scale",
      from_surface: "test:a",
      to_surface: "test:b",
      concept_ids: [ids[i % ids.length]!],
      directive: `directive ${i} ` + "d".repeat(TEN_X.directiveBytes),
    });
    if (i % 2 === 0) returnHandoff(dbx, { handoff_id: h.id, return_note: `note ${i} ` + "n".repeat(2_000) });
  }
  return ids;
}

test("read_project_state stays under 2s and under the cap at 10x scale", () => {
  seedTenX(db);
  const t0 = performance.now();
  const res = callTool(db, "read_project_state", { project: "scale" });
  const ms = performance.now() - t0;
  expect(res.isError).toBeUndefined();
  expect(ms).toBeLessThan(2_000); // spec acceptance: lean state read < 2s at 10x
  console.error(`[scale] read_project_state at 10x: ${Math.round(ms)}ms, ${res.content[0]!.text.length} bytes`);
}, 30_000);

test("wedge soak: heavy read -> immediate return_handoff over real stdio, repeatedly", async () => {
  seedTenX(db);
  // fresh pending handoffs to return during the soak, one per iteration
  const cid = writeConcept(db, {
    project: "scale", type: "note", title: "soak cargo", body: "c", surface: "test:scale",
  }).id;
  const pending: string[] = [];
  for (let i = 0; i < 5; i++) {
    pending.push(
      openHandoff(db, {
        project: "scale", from_surface: "test:a", to_surface: "test:b",
        concept_ids: [cid], directive: `soak ${i} ` + "d".repeat(TEN_X.directiveBytes),
      }).id,
    );
  }
  db.close(); // the spawned server owns the pool now (reopened by afterEach's close via initDb below)

  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "index.ts")], {
    env: { ...process.env, HEADWATER_DATA_DIR: tempDir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  /** Read frames until the message with this id arrives, or the deadline passes. */
  async function readUntil(id: number, deadlineMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (frame.trim()) {
          const msg = JSON.parse(frame) as Record<string, unknown>;
          if (msg.id === id) return msg;
          continue; // a notification or another id — keep reading
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no response for id ${id} within ${deadlineMs}ms — WEDGE?`);
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`stdout read stalled (id ${id}) — WEDGE?`)), remaining)),
      ]);
      if (chunk.done) throw new Error("server closed stdout");
      buffer += decoder.decode(chunk.value);
    }
  }
  function send(msg: Record<string, unknown>): void {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
  }

  try {
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wedge-soak", version: "0" } },
    });
    await readUntil(1, 10_000);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    let nextId = 2;
    for (const handoffId of pending) {
      const readId = nextId++;
      const t0 = performance.now();
      send({
        jsonrpc: "2.0", id: readId, method: "tools/call",
        params: { name: "read_project_state", arguments: { project: "scale" } },
      });
      await readUntil(readId, 5_000); // the heavy read must answer promptly
      const readMs = Math.round(performance.now() - t0);

      const writeId = nextId++;
      const t1 = performance.now();
      send({
        jsonrpc: "2.0", id: writeId, method: "tools/call",
        params: { name: "return_handoff", arguments: { handoff_id: handoffId, return_note: `soak return ${handoffId}` } },
      });
      const writeResp = (await readUntil(writeId, 5_000)) as { result?: { isError?: boolean } };
      const writeMs = Math.round(performance.now() - t1);
      expect(writeResp.result?.isError).toBeFalsy();
      console.error(`[soak] read ${readMs}ms -> return ${writeMs}ms (${handoffId})`);
    }
    console.error("[soak] wedge pattern did NOT reproduce: 5x heavy-read -> immediate-return, all under deadline");
  } finally {
    proc.kill();
    await proc.exited;
    db = initDb(join(tempDir, "pool.db")); // afterEach closes db; reopen so it has one to close
  }
}, 60_000);
```

- [ ] **Step 2: Run the new tests**

Run: `bun test tests/reliability.test.ts`
Expected: PASS. The soak logs per-iteration timings to stderr and states plainly whether the wedge reproduced. **If the soak FAILS with a `WEDGE?` error: that is a successful reproduction — do not weaken the test.** Report it as DONE_WITH_CONCERNS with the timings; the reproduction becomes the pinned regression and the fix is a separate, deliberate change.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: all pass (111 = 109 + 2 new).

- [ ] **Step 4: Update CLAUDE.md**

Three edits:

**(a)** In `## Data — one authoritative SQLite pool` → invariants list, replace the line

```
  - **Handoff `payload_snapshot` and `directive` are frozen at creation.** Only `status`/`returned_at`/
    `return_note` move in place (`pending → returned` in v1).
```

with

```
  - **Handoff `payload_snapshot` and `directive` are frozen at creation.** Only `status`/`returned_at`/
    `return_note` move in place, and the transition is **one-way**: `pending → returned` is the only
    status change the substrate admits (schema-v3 trigger `handoff_return_is_one_way`), so a stored
    return can never be overwritten — a retried `return_handoff` with the identical note is a no-op
    (`already_returned: true`), a different note is refused naming the stored `returned_at`. The
    `consumed`/`dropped` headroom statuses are unreachable until that trigger is deliberately revised.
```

**(b)** In `## The six MCP tools`, replace the `read_project_state` bullet's last sentence (`The viewer groups and badges the same way. Do not add a status-update path; this is the settled alternative.`) — keep it, and append after it:

```
  Pending handoffs arrive once (in `open_handoffs`, directive whole — it is the actionable payload);
  returned handoffs are archive: `directive_preview`/`return_note_preview` (280 chars) + ids+titles
  snapshots. `recent_concepts` are heads (id/type/title/status/created_at) — their full summaries sit in
  `concepts_by_status`. Oversized responses (default cap 131072 bytes, `HEADWATER_MAX_RESPONSE_BYTES`)
  **degrade** to ids+titles+counts with `degraded: true` — never an error. `open_handoff`/`return_handoff`
  return slim confirmations (id, surfaces, status, timestamps, concept_ids), not the frozen snapshot.
```

**(c)** In `## Run`, append to the stdio bullet:

```
  Every tool call appends one JSONL line (op, project, ok, ms, req/resp bytes, degraded, error) to
  `<data dir>/headwater.log` — a file, never stderr: an undrained stderr pipe would wedge the server.
```

- [ ] **Step 5: Update README.md**

In `## Data`, after the `HEADWATER_DATA_DIR` bullet list and before the "The repo holds code only" line, add:

```markdown
- Every tool call appends one JSON line to `<data dir>/headwater.log` (op, project, outcome, duration,
  request/response bytes) — the first place to look when a client misbehaves.
- `read_project_state` responses over 128 KB (override: `HEADWATER_MAX_RESPONSE_BYTES`) degrade to
  ids + titles + counts with `degraded: true` instead of ever exceeding the budget; `read_concept(id)`
  recalls any full text.
```

- [ ] **Step 6: Run the full suite one last time**

Run: `bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add tests/reliability.test.ts CLAUDE.md README.md
git commit -m "test(reliability): 10x scale + wedge soak over real stdio; document the hardening

The soak spawns the actual server (src/index.ts), speaks newline-delimited
JSON-RPC over real pipes at ~10x scale (600 concepts, 50 handoffs, 5KB
directives), and drives the wedge pattern: heavy read_project_state ->
immediate return_handoff, five rounds, hard 5s deadlines. Reports plainly
whether the wedge reproduces. Docs: the one-way handoff invariant, the
archive-preview state shape, headwater.log, and the degrade cap."
```

---

## Post-implementation (controller, not a task)

- Verify against a scratchpad COPY of the live pool: `read_project_state("threadkey")` size (< 80 KB expected), retry-clobber refused, `already_returned` on identical retry.
- Record the outcome in the pool: fork the safety-notice constraint (`do-not-retry-return-handoff-...-0b12f915`, kind `supersedes`) — the "do not retry" instruction flips to "retries are safe as of <commit>"; fork the Spec A decision trail similarly.
- The ThreadKey verification protocol (their side): lean state read, deliberate repeated `return_handoff` — now safe by construction.

## Self-review notes (already applied)

- Task 3's dispatcher replaces Task 2's step 3(e) wiring edits — called out explicitly in both places.
- `loop.test.ts:157` (unknown-id double return) and `:136-140` (recents after return) survive; `:923` is the one shape-dependent assertion, updated in Task 2.
- The v2→v3 upgrade path is tested (drop trigger + reset user_version + reopen).
- The soak's `db.close()`/reopen dance around the spawned server avoids two writers and keeps `afterEach` sound on Windows.
