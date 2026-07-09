// backup.test.ts — proves the backup script's two load-bearing properties: a snapshot of a LIVE
// WAL-mode pool captures rows that are still sitting in the -wal file (a plain `cp` does not), and a
// snapshot is rejected unless it passes integrity_check AND its append-only row counts have not shrunk.
// Everything runs against throwaway pools in temp dirs; the operator's real pool is never opened.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.ts";
import { writeConcept } from "../src/server.ts";
import {
  snapshotName,
  snapshot,
  countsOf,
  integrityOk,
  verify,
  listSnapshots,
  newestSnapshot,
  publish,
  prune,
} from "../scripts/backup.ts";

let tempDir: string;
let db: Database;
let poolPath: string;

const SURFACE = "test:backup";

/** Seed `n` concepts through the real tool function — no raw SQL, no new write path. */
function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    writeConcept(db, {
      project: "backup-test",
      type: "note",
      title: `concept ${i}`,
      body: `body ${i}`,
      surface: SURFACE,
    });
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "headwater-backup-"));
  poolPath = join(tempDir, "pool.db");
  db = initDb(poolPath);
});

afterEach(() => {
  db.close(); // release the handle before deleting (Windows locks open files)
  rmSync(tempDir, { recursive: true, force: true });
});

test("snapshotName is UTC, second-precision, and lexically sortable", () => {
  const name = snapshotName(new Date("2026-07-09T05:19:53.560Z"));
  expect(name).toBe("pool-2026-07-09T05-19-53Z.db");
  // lexical order == chronological order
  const earlier = snapshotName(new Date("2026-07-09T05:19:52.000Z"));
  expect([name, earlier].sort()).toEqual([earlier, name]);
});

test("snapshot captures rows still sitting in the WAL, and passes integrity_check", () => {
  seed(3);

  // The pool is open and un-checkpointed: the rows live in the -wal file, not pool.db.
  const wal = join(tempDir, "pool.db-wal");
  expect(existsSync(wal)).toBe(true);
  expect(statSync(wal).size).toBeGreaterThan(0);

  const out = join(tempDir, "snap.db");
  snapshot(poolPath, out); // live source, still open by `db`

  expect(integrityOk(out)).toBe(true);
  expect(countsOf(out)).toEqual({ concept: 3, lineage: 0, handoff: 0 });
});

test("a naive copy of pool.db alone does NOT capture the WAL rows", () => {
  seed(3);

  const naive = join(tempDir, "naive.db");
  copyFileSync(poolPath, naive); // the tempting, wrong thing

  // The copy either has fewer rows than the live pool, or no schema at all (the DDL is also in the
  // WAL). Both are silent data loss: neither raises an error at copy time. This is the whole reason
  // `snapshot()` exists — see the header comment in scripts/backup.ts.
  let naiveConcepts: number | null;
  try {
    naiveConcepts = countsOf(naive).concept;
  } catch {
    naiveConcepts = null; // tables not even present in the main file yet
  }
  expect(naiveConcepts === null || naiveConcepts < 3).toBe(true);
});

test("snapshot does not modify the source pool", () => {
  seed(2);
  const before = statSync(poolPath);

  snapshot(poolPath, join(tempDir, "snap.db"));

  const after = statSync(poolPath);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test("snapshot overwrites a stale destination (VACUUM INTO refuses an existing target)", () => {
  seed(1);
  const out = join(tempDir, "snap.db");
  snapshot(poolPath, out);
  seed(1);
  snapshot(poolPath, out); // must not throw
  expect(countsOf(out).concept).toBe(2);
});

test("verify accepts a good snapshot and returns its counts", () => {
  seed(3);
  const out = join(tempDir, "snap.db");
  snapshot(poolPath, out);

  expect(verify(out, null)).toEqual({ concept: 3, lineage: 0, handoff: 0 });
  expect(verify(out, { concept: 1, lineage: 0, handoff: 0 })).toEqual({
    concept: 3,
    lineage: 0,
    handoff: 0,
  });
});

test("verify rejects a snapshot whose append-only counts went backwards", () => {
  seed(3);
  const out = join(tempDir, "snap.db");
  snapshot(poolPath, out);

  expect(() => verify(out, { concept: 99, lineage: 0, handoff: 0 })).toThrow(
    /concept count went backwards: 99 -> 3/,
  );
  expect(() => verify(out, { concept: 0, lineage: 7, handoff: 0 })).toThrow(
    /lineage count went backwards/,
  );
  expect(() => verify(out, { concept: 0, lineage: 0, handoff: 4 })).toThrow(
    /handoff count went backwards/,
  );
});

test("verify rejects a snapshot it cannot read as a pool", () => {
  const junk = join(tempDir, "corrupt.db");
  writeFileSync(junk, Buffer.alloc(4096)); // not a pool: no schema, or not SQLite at all
  // Whether it fails at open, at integrity_check, or at `SELECT ... FROM concept`, verify() must throw
  // rather than hand back a snapshot we would then publish and prune against.
  expect(() => verify(junk, null)).toThrow();
});

/** Create an empty file at `dir/name`. Content is irrelevant to listing/pruning. */
function touch(dir: string, name: string): void {
  writeFileSync(join(dir, name), "");
}

test("listSnapshots returns only real snapshots, oldest first", () => {
  const dir = join(tempDir, "backups");
  mkdirSync(dir, { recursive: true });
  touch(dir, "pool-2026-01-03T00-00-00Z.db");
  touch(dir, "pool-2026-01-01T00-00-00Z.db");
  touch(dir, "pool-2026-01-02T00-00-00Z.db");
  touch(dir, ".pool-2026-01-04T00-00-00Z.db.tmp"); // in-flight write
  touch(dir, "pool-2026-01-05T00-00-00Z.db.rejected"); // failed verify
  touch(dir, "notes.txt");

  expect(listSnapshots(dir)).toEqual([
    "pool-2026-01-01T00-00-00Z.db",
    "pool-2026-01-02T00-00-00Z.db",
    "pool-2026-01-03T00-00-00Z.db",
  ]);
  expect(newestSnapshot(dir)).toBe("pool-2026-01-03T00-00-00Z.db");
});

test("listSnapshots and newestSnapshot tolerate a missing directory", () => {
  const dir = join(tempDir, "does-not-exist");
  expect(listSnapshots(dir)).toEqual([]);
  expect(newestSnapshot(dir)).toBeNull();
});

test("publish renames the temp file into place", () => {
  seed(1);
  const dir = join(tempDir, "backups");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, ".pool-2026-01-01T00-00-00Z.db.tmp");
  const final = join(dir, "pool-2026-01-01T00-00-00Z.db");

  snapshot(poolPath, tmp);
  publish(tmp, final);

  expect(existsSync(tmp)).toBe(false);
  expect(existsSync(final)).toBe(true);
  expect(countsOf(final).concept).toBe(1);
});

test("prune keeps exactly the newest N and never deletes the newest", () => {
  const dir = join(tempDir, "backups");
  mkdirSync(dir, { recursive: true });
  for (const d of ["01", "02", "03", "04", "05"]) touch(dir, `pool-2026-01-${d}T00-00-00Z.db`);

  const dropped = prune(dir, 2);

  expect(dropped).toEqual([
    "pool-2026-01-01T00-00-00Z.db",
    "pool-2026-01-02T00-00-00Z.db",
    "pool-2026-01-03T00-00-00Z.db",
  ]);
  expect(listSnapshots(dir)).toEqual([
    "pool-2026-01-04T00-00-00Z.db",
    "pool-2026-01-05T00-00-00Z.db",
  ]);
});

test("prune is a no-op when there are fewer snapshots than the retention count", () => {
  const dir = join(tempDir, "backups");
  mkdirSync(dir, { recursive: true });
  touch(dir, "pool-2026-01-01T00-00-00Z.db");
  expect(prune(dir, 14)).toEqual([]);
  expect(listSnapshots(dir).length).toBe(1);
});

test("prune refuses a retention count below 1", () => {
  const dir = join(tempDir, "backups");
  mkdirSync(dir, { recursive: true });
  expect(() => prune(dir, 0)).toThrow(/keep must be >= 1/);
});
