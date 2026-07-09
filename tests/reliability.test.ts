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
import { writeConcept, openHandoff, returnHandoff, readProjectState, confirmHandoff } from "../src/server.ts";
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
