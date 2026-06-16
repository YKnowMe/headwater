// loop.test.ts — proves the one real loop end to end against a temp on-disk pool:
//   write a concept -> read it by id -> fork it -> open a handoff carrying it -> return it.
// Asserts every state transition plus the invariants: concepts are immutable, the fork adds a
// child->parent lineage edge without touching the parent, and a handoff's directive +
// payload_snapshot are frozen while only its status/return fields move.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.ts";
import {
  writeConcept,
  readConcept,
  forkConcept,
  openHandoff,
  returnHandoff,
  readProjectState,
} from "../src/server.ts";

let tempDir: string;
let db: Database;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "headwater-test-"));
  db = initDb(join(tempDir, "pool.db"));
});

afterAll(() => {
  db.close(); // release the file handle before deleting (Windows locks open files)
  rmSync(tempDir, { recursive: true, force: true });
});

const PROJECT = "Headwater Demo";
const PROJECT_ID = "headwater-demo";

test("closes the loop: write -> read -> fork -> handoff -> return", () => {
  // 1) WRITE a concept ------------------------------------------------------
  const concept = writeConcept(db, {
    project: PROJECT,
    type: "decision",
    title: "Adopt Bun",
    body: "Use Bun as the runtime and package manager.",
    surface: "code-session-alpha",
  });
  expect(typeof concept.id).toBe("string");
  expect(concept.id.length).toBeGreaterThan(0);
  expect(concept.title).toBe("Adopt Bun");
  expect(concept.type).toBe("decision");
  expect(concept.status).toBe("active"); // default applied
  expect(concept.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // project + surface upserted on first mention
  expect(concept.project_id).toBe(PROJECT_ID);
  expect(concept.origin_surface_id).toBe("code-session-alpha");

  // 2) READ it back by id ---------------------------------------------------
  const recalled = readConcept(db, concept.id);
  expect(recalled).toEqual(concept);

  // 3) FORK it --------------------------------------------------------------
  const fork = forkConcept(db, {
    parent_id: concept.id,
    body: "Reconsider: pin the Bun version for reproducibility.",
    surface: "desktop-chat-beta",
    kind: "forks_from",
    reason: "correction",
  });
  expect(fork.id).not.toBe(concept.id); // a new node, not a mutation
  expect(fork.project_id).toBe(concept.project_id); // stays in the parent's project
  expect(fork.origin_surface_id).toBe("desktop-chat-beta"); // origin = forking surface
  expect(fork.title).toBe(concept.title); // no title given -> carries parent's
  expect(fork.type).toBe("note"); // default type

  // immutability: the original is byte-for-byte unchanged after the fork
  expect(readConcept(db, concept.id)).toEqual(concept);

  // a single child -> parent lineage edge was appended
  const edges = db
    .query<
      { id: string; from_concept_id: string; to_concept_id: string; kind: string; reason: string | null },
      [string]
    >(`SELECT * FROM lineage WHERE from_concept_id = ?`)
    .all(fork.id);
  expect(edges).toHaveLength(1);
  expect(edges[0]!.from_concept_id).toBe(fork.id); // child
  expect(edges[0]!.to_concept_id).toBe(concept.id); // parent (canonical root)
  expect(edges[0]!.kind).toBe("forks_from");
  expect(edges[0]!.reason).toBe("correction");

  // 4) OPEN a handoff carrying both concepts --------------------------------
  const handoff = openHandoff(db, {
    project: PROJECT,
    from_surface: "code-session-alpha",
    to_surface: "desktop-chat-beta",
    concept_ids: [concept.id, fork.id],
    directive: "Confirm the Bun decision and review its fork.",
  });
  expect(handoff.status).toBe("pending");
  expect(handoff.returned_at).toBeNull();
  expect(handoff.return_note).toBeNull();
  expect(handoff.initiated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // payload_snapshot is a frozen JSON copy of exactly the carried concepts
  const snapshot = JSON.parse(handoff.payload_snapshot) as Array<{ id: string }>;
  expect(snapshot).toHaveLength(2);
  expect(snapshot.map((c) => c.id).sort()).toEqual([concept.id, fork.id].sort());

  // join rows recorded for both carried concepts
  const joined = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM handoff_concept WHERE handoff_id = ?`)
    .get(handoff.id)!;
  expect(joined.n).toBe(2);

  // project state surfaces the pending handoff and both active concepts
  const stateBefore = readProjectState(db, PROJECT);
  expect(stateBefore.exists).toBe(true);
  expect(stateBefore.open_handoffs).toHaveLength(1);
  expect(stateBefore.concepts_by_status.active).toHaveLength(2);

  // 5) RETURN the handoff ---------------------------------------------------
  const returned = returnHandoff(db, {
    handoff_id: handoff.id,
    return_note: "Confirmed; version pinned in package.json.",
  });
  expect(returned.id).toBe(handoff.id);
  expect(returned.status).toBe("returned"); // status moved in place
  expect(returned.return_note).toBe("Confirmed; version pinned in package.json.");
  expect(returned.returned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // directive + snapshot are frozen — unchanged by the return
  expect(returned.directive).toBe(handoff.directive);
  expect(returned.payload_snapshot).toBe(handoff.payload_snapshot);

  // project state now shows no open handoffs, one returned in recents
  const stateAfter = readProjectState(db, PROJECT);
  expect(stateAfter.open_handoffs).toHaveLength(0);
  expect(stateAfter.recent_handoffs).toHaveLength(1);
  expect(stateAfter.recent_handoffs[0]?.status).toBe("returned");
});

test("guards: unknown ids are rejected, not silently coerced", () => {
  expect(() => readConcept(db, "does-not-exist")).toThrow(/unknown concept/);
  expect(() =>
    forkConcept(db, { parent_id: "missing-parent", body: "x", surface: "op" }),
  ).toThrow(/unknown parent concept/);
  expect(() =>
    openHandoff(db, {
      project: PROJECT,
      from_surface: "a",
      to_surface: "b",
      concept_ids: ["ghost-concept"],
      directive: "carry a ghost",
    }),
  ).toThrow(/unknown concept in handoff/);
  expect(() => returnHandoff(db, { handoff_id: "no-such-handoff", return_note: "n/a" })).toThrow(
    /unknown handoff/,
  );
});

test("read_project_state on an unseen project returns empty context, not an error", () => {
  const state = readProjectState(db, "Never Seen");
  expect(state.exists).toBe(false);
  expect(state.concepts_by_status.active).toHaveLength(0);
  expect(state.open_handoffs).toHaveLength(0);
  expect(state.recent_concepts).toHaveLength(0);
});
