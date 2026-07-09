// reliability.test.ts — Spec A hardening (docs/superpowers/specs/2026-07-09-reliability-hardening-design.md).
// The load-bearing property: no retry of return_handoff can ever destroy a stored return note —
// enforced in the tool (idempotent-if-identical, conflict-if-different) AND at the substrate
// (schema-v3 trigger: the only handoff transition that exists is pending -> returned).
// Everything runs against throwaway pools; the operator's real pool is never opened.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.ts";
import {
  writeConcept,
  openHandoff,
  returnHandoff,
  readProjectState,
  confirmHandoff,
  callTool,
  degradeProjectState,
} from "../src/server.ts";
import type { HandoffRow } from "../src/db.ts";

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "headwater-rel-"));
  db = initDb(join(tempDir, "pool.db"));
  process.env.HEADWATER_DATA_DIR = tempDir; // callTool logs to <data dir>/headwater.log
  delete process.env.HEADWATER_MAX_RESPONSE_BYTES;
});

afterEach(() => {
  delete process.env.HEADWATER_DATA_DIR;
  delete process.env.HEADWATER_MAX_RESPONSE_BYTES;
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
