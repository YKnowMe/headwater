# Pool Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the authoritative pool (`~/.workspace/pool.db`) a safe, verified, daily backup with local history and an offsite copy.

**Architecture:** One script, `scripts/backup.ts`, exporting small pure-ish functions plus a `main()` that sequences them. It snapshots the live pool with `VACUUM INTO` over a **read-only** connection (the only mode that works, and the only one that structurally cannot write to the pool), verifies the snapshot with `PRAGMA integrity_check` plus a monotonic row-count tripwire, publishes timestamped copies to a local history dir and an offsite dir by atomic rename, and prunes both to the newest 14. Restore stays a documented manual procedure.

**Tech Stack:** TypeScript on Bun. `bun:sqlite` and `node:fs`/`node:os`/`node:path` — all Bun/Node built-ins. `bun:test` for tests.

Spec: `docs/superpowers/specs/2026-07-09-pool-backup-design.md` (commit `c65a013`).
Decision concept: `back-up-the-pool-with-read-only-vacuum-into-local-history-onedrive-offsite-daily-eca86176`.

## Global Constraints

- **No new runtime dependencies.** The two runtime deps stay `@modelcontextprotocol/sdk` and `zod`. `bun:sqlite`, `node:fs`, `node:os`, `node:path` are built-ins and are allowed.
- **Never write to the pool.** Every connection this script opens to the source pool MUST pass `{ readonly: true }`. A read-write connection fails with `SQLITE_MISUSE` anyway; the readonly flag is the guarantee, not the workaround.
- **Never `UPDATE` or `DELETE` pool rows.** This script only reads.
- **Logs go to stderr** (`console.error`), never stdout. Matches the repo's stdio discipline.
- **Windows is the target platform.** Always `db.close()` before `rmSync` on a directory containing SQLite files, or the delete fails on locked handles. Existing tests do this (`tests/loop.test.ts:33`).
- **File additions are a recorded exception** to CLAUDE.md's closed file list: `scripts/backup.ts` and `tests/backup.test.ts` only. Do not add others.
- Reuse `resolveDataDir()` and `resolveDbPath()` from `src/db.ts` — do not re-implement path resolution.
- Snapshot filename format is exactly `pool-YYYY-MM-DDTHH-MM-SSZ.db`. It is UTC, second-precision, and sorts lexically in chronological order. Everything downstream (listing, pruning, "newest") depends on that property.
- Retention default is **14**. `HEADWATER_BACKUP_KEEP` overrides it; `HEADWATER_BACKUP_DIR` overrides the offsite destination. Both overrides exist chiefly so tests can point at temp dirs.
- **On any failure, prune nothing.** A failed run must never delete an old snapshot.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/backup.ts` | **Create.** Snapshot, verify, publish, prune, and the `main()` that sequences them. |
| `tests/backup.test.ts` | **Create.** `bun:test` coverage against temp pools; never touches the real pool. |
| `package.json` | **Modify.** Add the `backup` script entry. |
| `CLAUDE.md` | **Modify.** Record the new file + the backup posture. |
| `README.md` | **Modify.** Add `### Backup and restore` with the manual restore procedure. |

---

### Task 1: Snapshot and verify

The heart of the change: take a consistent snapshot of a live WAL-mode pool, and refuse to accept a bad one.

**Files:**
- Create: `scripts/backup.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Consumes: `resolveDataDir()`, `resolveDbPath()` from `src/db.ts`; `initDb()` and `writeConcept()` in tests only.
- Produces:
  - `DEFAULT_KEEP: number` (= 14)
  - `interface PoolCounts { concept: number; lineage: number; handoff: number }`
  - `snapshotName(now: Date): string`
  - `snapshot(srcPath: string, destPath: string): void`
  - `countsOf(dbPath: string): PoolCounts`
  - `integrityOk(dbPath: string): boolean`
  - `verify(snapshotPath: string, prev: PoolCounts | null): PoolCounts` — throws on failure, returns the snapshot's counts on success.

- [ ] **Step 1: Write the failing tests**

Create `tests/backup.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/backup.test.ts`
Expected: FAIL — `Cannot find module '../scripts/backup.ts'`

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/backup.ts`:

```ts
// backup.ts — snapshot the authoritative pool safely, keeping local history + an offsite copy.
//
// Why not `cp pool.db`: the pool runs in WAL mode (src/db.ts), so committed transactions live in
// pool.db-wal until a checkpoint folds them into the main file. A plain file copy silently loses them
// and the result STILL passes PRAGMA integrity_check — measured on the real pool, a `cp` dropped 7
// concepts and a whole handoff. `VACUUM INTO` over a READ-ONLY connection takes a consistent snapshot
// of a live database (WAL folded in) and cannot write to the source; a read-write connection fails
// outright with SQLITE_MISUSE. The output is a standalone .db — no -wal, no -shm to reassemble.
//
// Verification: integrity_check, plus a monotonic row-count tripwire. Concepts are immutable and
// lineage/handoff_concept are append-only (schema-v2 triggers reject every DELETE), so row counts can
// never decrease between snapshots. A decrease means corruption, truncation, or the wrong source file.
// On ANY failure we keep the rejected snapshot for inspection and prune nothing.
//
// Run: `bun run backup`. Restore is a documented manual procedure — see README.

import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

export const DEFAULT_KEEP = 14;

export interface PoolCounts {
  concept: number;
  lineage: number;
  handoff: number;
}

/** `pool-2026-07-09T05-19-53Z.db` — UTC, second-precision, lexically sortable == chronological. */
export function snapshotName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return `pool-${stamp}.db`;
}

/** Consistent snapshot of a live WAL-mode pool. Read-only: cannot touch the source. */
export function snapshot(srcPath: string, destPath: string): void {
  rmSync(destPath, { force: true }); // VACUUM INTO refuses an existing target
  const db = new Database(srcPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

export function countsOf(dbPath: string): PoolCounts {
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (t: string) => (db.query(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c;
    return { concept: one("concept"), lineage: one("lineage"), handoff: one("handoff") };
  } finally {
    db.close();
  }
}

export function integrityOk(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query(`PRAGMA integrity_check`).get() as { integrity_check: string } | null;
    return row?.integrity_check === "ok";
  } finally {
    db.close();
  }
}

/**
 * Accept a snapshot only if it is structurally sound AND no append-only table shrank against the
 * previous snapshot. Throws on rejection; returns the snapshot's counts on success.
 */
export function verify(snapshotPath: string, prev: PoolCounts | null): PoolCounts {
  if (!integrityOk(snapshotPath)) throw new Error(`integrity_check failed for ${snapshotPath}`);
  const counts = countsOf(snapshotPath);
  if (prev) {
    for (const table of ["concept", "lineage", "handoff"] as const) {
      if (counts[table] < prev[table]) {
        throw new Error(
          `${table} count went backwards: ${prev[table]} -> ${counts[table]} ` +
            `(append-only tables cannot shrink — corruption, truncation, or the wrong source pool)`,
        );
      }
    }
  }
  return counts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/backup.test.ts`
Expected: PASS, 8 tests.

A zero-filled 4096-byte file may open as an *empty* database rather than an invalid one, in which case `integrityOk` returns `true` and the throw comes from `countsOf` hitting `no such table: concept`. Either path throws from inside `verify`, so `toThrow()` passes. If it somehow does not throw, replace the junk with a truncated real snapshot: `writeFileSync(junk, readFileSync(out).subarray(0, 2048))`.

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `bun test`
Expected: every existing test still passes, plus the 8 new ones.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup.ts tests/backup.test.ts
git commit -m "feat(backup): consistent pool snapshots via read-only VACUUM INTO

A plain cp of pool.db loses un-checkpointed WAL commits and still passes
integrity_check. VACUUM INTO over a read-only connection is consistent and
cannot write to the source. Verified by integrity_check plus a monotonic
row-count tripwire the append-only schema makes free."
```

---

### Task 2: Publish and prune

Get verified snapshots into place atomically, and keep the directory bounded.

**Files:**
- Modify: `scripts/backup.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Consumes: `snapshotName`, `snapshot`, `countsOf` from Task 1.
- Produces:
  - `listSnapshots(dir: string): string[]` — filenames only, ascending (oldest first). Ignores `.tmp` and `.rejected` files.
  - `newestSnapshot(dir: string): string | null`
  - `publish(tmpPath: string, finalPath: string): void`
  - `prune(dir: string, keep: number): string[]` — returns the filenames deleted.

- [ ] **Step 1: Write the failing tests**

Append to `tests/backup.test.ts`. Extend the import from `../scripts/backup.ts` to add `listSnapshots`, `newestSnapshot`, `publish`, `prune`. The `node:fs` import from Task 1 already covers everything used here.

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/backup.test.ts`
Expected: FAIL — `listSnapshots is not a function` (or an import error naming it).

- [ ] **Step 3: Write the minimal implementation**

In `scripts/backup.ts`, extend the `node:fs` import and add the functions below `verify`:

```ts
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
```

```ts
/** Matches only published snapshots — never `.tmp` (in flight) or `.rejected` (failed verify). */
const SNAPSHOT_RE = /^pool-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/;

/** Published snapshots, oldest first. Lexical sort == chronological, by construction of the name. */
export function listSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => SNAPSHOT_RE.test(f)).sort();
}

export function newestSnapshot(dir: string): string | null {
  const all = listSnapshots(dir);
  return all.length > 0 ? all[all.length - 1]! : null;
}

/** Atomic within a volume: an interrupted run never leaves a half-written file that looks good. */
export function publish(tmpPath: string, finalPath: string): void {
  renameSync(tmpPath, finalPath);
}

/** Delete all but the `keep` newest snapshots. Returns what was deleted. */
export function prune(dir: string, keep: number): string[] {
  if (keep < 1) throw new Error(`keep must be >= 1, got ${keep}`);
  const all = listSnapshots(dir);
  const doomed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of doomed) rmSync(join(dir, f), { force: true });
  return doomed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/backup.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup.ts tests/backup.test.ts
git commit -m "feat(backup): atomic publish + bounded retention

Snapshots are written to a .tmp name and renamed into place, so an
interrupted run cannot leave a half-written file that looks like a good
backup. prune keeps the newest N and never touches the newest."
```

---

### Task 3: Orchestration, destinations, and exit codes

Wire it together. This is where the "half of both is not both" policy lives.

**Files:**
- Modify: `scripts/backup.ts`
- Modify: `package.json`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2; `resolveDataDir()` and `resolveDbPath()` from `src/db.ts`.
- Produces:
  - `resolveLocalBackupDir(): string` — `<data dir>/backups`
  - `resolveOffsiteDir(): string` — `$HEADWATER_BACKUP_DIR`, else `~/OneDrive/headwater-backups`
  - `resolveKeep(): number` — `$HEADWATER_BACKUP_KEEP` if a valid integer ≥ 1, else `DEFAULT_KEEP`
  - `previousCounts(dir: string): PoolCounts | null` — counts of the newest published snapshot, or `null` if there is none **or it cannot be read**.
  - `main(now?: Date): number` — process exit code. `0` success, `1` any failure.

**Why `previousCounts` swallows errors:** the tripwire compares against the newest existing snapshot. If that file is truncated, zero-length, or otherwise unreadable, opening it throws — and a backup script that *crashes because an old backup is damaged* is exactly backwards. Treat an unreadable predecessor as "no predecessor": warn on stderr, skip the comparison, and still take today's snapshot. The `integrity_check` half of `verify` is unaffected.

**Behaviour contract (implement exactly):**

| Condition | Behaviour |
| --- | --- |
| source pool absent | stderr, exit 1, nothing written |
| `integrity_check` ≠ `ok`, or a count shrank | rename tmp → `<name>.rejected`, exit 1, **prune nothing** |
| previous snapshot unreadable | warn, skip the shrink check, **continue** — a damaged old backup never blocks a new one |
| offsite **parent** dir absent | local snapshot published, exit 1, **prune nothing** |
| success | both published, both pruned to `keep`, exit 0, no `.tmp` left |

The offsite *parent* (e.g. `~/OneDrive`) must already exist — we create `headwater-backups/` inside it, but never conjure a missing OneDrive root, because doing so would produce a local directory that never syncs and a backup that only looks offsite.

- [ ] **Step 1: Write the failing tests**

Append to `tests/backup.test.ts`. Extend the `../scripts/backup.ts` import with `main`, `resolveKeep`, `resolveOffsiteDir`, `previousCounts`, `DEFAULT_KEEP`. The `node:fs` import from Task 1 already covers everything used here.

Add env isolation — put this inside the existing `beforeEach` (after `db = initDb(poolPath)`) and `afterEach` (before `db.close()`):

```ts
// in beforeEach:
process.env.HEADWATER_DATA_DIR = tempDir; // main() resolves the pool from this
delete process.env.HEADWATER_BACKUP_DIR;
delete process.env.HEADWATER_BACKUP_KEEP;

// in afterEach:
delete process.env.HEADWATER_DATA_DIR;
delete process.env.HEADWATER_BACKUP_DIR;
delete process.env.HEADWATER_BACKUP_KEEP;
```

```ts
/** An offsite dir whose PARENT exists — the shape main() requires. */
function offsiteUnder(root: string): string {
  mkdirSync(join(root, "cloud"), { recursive: true });
  return join(root, "cloud", "headwater-backups");
}

test("resolveKeep honours a valid override and falls back otherwise", () => {
  expect(resolveKeep()).toBe(DEFAULT_KEEP);
  process.env.HEADWATER_BACKUP_KEEP = "3";
  expect(resolveKeep()).toBe(3);
  process.env.HEADWATER_BACKUP_KEEP = "0";
  expect(resolveKeep()).toBe(DEFAULT_KEEP);
  process.env.HEADWATER_BACKUP_KEEP = "banana";
  expect(resolveKeep()).toBe(DEFAULT_KEEP);
});

test("resolveOffsiteDir honours HEADWATER_BACKUP_DIR", () => {
  process.env.HEADWATER_BACKUP_DIR = "D:/somewhere/else";
  expect(resolveOffsiteDir()).toBe("D:/somewhere/else");
});

test("main publishes to both destinations, leaves no .tmp, and exits 0", () => {
  seed(3);
  const offsite = offsiteUnder(tempDir);
  process.env.HEADWATER_BACKUP_DIR = offsite;

  expect(main(new Date("2026-07-09T05:19:53.560Z"))).toBe(0);

  const local = join(tempDir, "backups");
  expect(listSnapshots(local)).toEqual(["pool-2026-07-09T05-19-53Z.db"]);
  expect(listSnapshots(offsite)).toEqual(["pool-2026-07-09T05-19-53Z.db"]);
  expect(countsOf(join(offsite, "pool-2026-07-09T05-19-53Z.db")).concept).toBe(3);

  for (const dir of [local, offsite]) {
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }
});

test("main prunes both destinations to the retention count", () => {
  seed(1);
  const offsite = offsiteUnder(tempDir);
  process.env.HEADWATER_BACKUP_DIR = offsite;
  process.env.HEADWATER_BACKUP_KEEP = "2";

  expect(main(new Date("2026-01-01T00:00:00Z"))).toBe(0);
  expect(main(new Date("2026-01-02T00:00:00Z"))).toBe(0);
  expect(main(new Date("2026-01-03T00:00:00Z"))).toBe(0);

  expect(listSnapshots(join(tempDir, "backups"))).toEqual([
    "pool-2026-01-02T00-00-00Z.db",
    "pool-2026-01-03T00-00-00Z.db",
  ]);
  expect(listSnapshots(offsite)).toEqual([
    "pool-2026-01-02T00-00-00Z.db",
    "pool-2026-01-03T00-00-00Z.db",
  ]);
});

test("main exits 1 and prunes nothing when the offsite parent is missing", () => {
  seed(1);
  process.env.HEADWATER_BACKUP_DIR = join(tempDir, "no-such-parent", "headwater-backups");
  process.env.HEADWATER_BACKUP_KEEP = "1";

  // A pre-existing REAL snapshot that a successful run WOULD have pruned (keep=1). It must be a real
  // snapshot, not an empty file: main() reads it to get the previous counts for the tripwire.
  const local = join(tempDir, "backups");
  mkdirSync(local, { recursive: true });
  snapshot(poolPath, join(local, "pool-2020-01-01T00-00-00Z.db"));

  expect(main(new Date("2026-07-09T05:19:53.560Z"))).toBe(1);

  // Local snapshot published, old one still there: a failed run prunes nothing.
  expect(listSnapshots(local)).toEqual([
    "pool-2020-01-01T00-00-00Z.db",
    "pool-2026-07-09T05-19-53Z.db",
  ]);
});

test("main rejects a snapshot whose counts shrank against the previous one", () => {
  // Plant a "previous" snapshot with MORE rows than the live pool: the tripwire must fire.
  const local = join(tempDir, "backups");
  mkdirSync(local, { recursive: true });

  const fatDir = mkdtempSync(join(tmpdir(), "headwater-fat-"));
  const fatDb = initDb(join(fatDir, "pool.db"));
  for (let i = 0; i < 5; i++) {
    writeConcept(fatDb, { project: "p", type: "note", title: `t${i}`, body: "b", surface: SURFACE });
  }
  snapshot(join(fatDir, "pool.db"), join(local, "pool-2020-01-01T00-00-00Z.db"));
  fatDb.close();
  rmSync(fatDir, { recursive: true, force: true });

  seed(3); // live pool has 3 < 5
  process.env.HEADWATER_BACKUP_DIR = offsiteUnder(tempDir);

  expect(main(new Date("2026-07-09T05:19:53.560Z"))).toBe(1);

  // Nothing published, nothing pruned, the evidence kept.
  expect(listSnapshots(local)).toEqual(["pool-2020-01-01T00-00-00Z.db"]);
  expect(existsSync(join(local, "pool-2026-07-09T05-19-53Z.db.rejected"))).toBe(true);
  expect(readdirSync(local).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("previousCounts treats an unreadable predecessor as absent, and main still succeeds", () => {
  seed(2);
  const local = join(tempDir, "backups");
  mkdirSync(local, { recursive: true });
  touch(local, "pool-2020-01-01T00-00-00Z.db"); // 0 bytes: a damaged old backup

  expect(previousCounts(local)).toBeNull(); // must not throw

  // A damaged OLD backup must never stop today's backup from being taken.
  process.env.HEADWATER_BACKUP_DIR = offsiteUnder(tempDir);
  expect(main(new Date("2026-07-09T05:19:53.560Z"))).toBe(0);
  expect(existsSync(join(local, "pool-2026-07-09T05-19-53Z.db"))).toBe(true);
});

test("main exits 1 when the pool does not exist", () => {
  db.close();
  rmSync(poolPath, { force: true });
  rmSync(join(tempDir, "pool.db-wal"), { force: true });
  rmSync(join(tempDir, "pool.db-shm"), { force: true });
  process.env.HEADWATER_BACKUP_DIR = offsiteUnder(tempDir);

  expect(main(new Date())).toBe(1);

  db = initDb(poolPath); // afterEach closes it
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/backup.test.ts`
Expected: FAIL — `main is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/backup.ts`, extend imports and append `main` plus the resolvers:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDataDir, resolveDbPath } from "../src/db.ts";
```

```ts
/** Local history — lives beside the pool, under whatever HEADWATER_DATA_DIR resolves to. */
export function resolveLocalBackupDir(): string {
  return join(resolveDataDir(), "backups");
}

/** Offsite copy. Default is the operator's OneDrive; tests point this at a temp dir. */
export function resolveOffsiteDir(): string {
  const override = process.env.HEADWATER_BACKUP_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), "OneDrive", "headwater-backups");
}

export function resolveKeep(): number {
  const raw = process.env.HEADWATER_BACKUP_KEEP;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP;
}

/**
 * Counts of the newest published snapshot — the tripwire's baseline. `null` when there is no
 * predecessor, and ALSO when the predecessor cannot be read: a damaged old backup must never stop
 * today's backup from being taken. We lose the shrink comparison for one run and say so; we do not
 * lose the backup. `integrity_check` on the new snapshot is unaffected.
 */
export function previousCounts(dir: string): PoolCounts | null {
  const prevName = newestSnapshot(dir);
  if (!prevName) return null;
  try {
    return countsOf(join(dir, prevName));
  } catch (err) {
    console.error(`backup: cannot read previous snapshot ${prevName} (${(err as Error).message})`);
    console.error(`backup: skipping the shrink check for this run`);
    return null;
  }
}

/** Exit code: 0 on success, 1 on any failure. A failed run publishes nothing new and prunes nothing. */
export function main(now: Date = new Date()): number {
  const src = resolveDbPath();
  if (!existsSync(src)) {
    console.error(`backup: no pool at ${src}`);
    return 1;
  }

  const localDir = resolveLocalBackupDir();
  mkdirSync(localDir, { recursive: true });

  const prev = previousCounts(localDir);

  const name = snapshotName(now);
  const tmp = join(localDir, `.${name}.tmp`);
  snapshot(src, tmp);

  let counts: PoolCounts;
  try {
    counts = verify(tmp, prev);
  } catch (err) {
    const rejected = join(localDir, `${name}.rejected`);
    renameSync(tmp, rejected);
    console.error(`backup: REJECTED — ${(err as Error).message}`);
    console.error(`backup: kept ${rejected} for inspection; pruned nothing`);
    return 1;
  }

  const localFinal = join(localDir, name);
  publish(tmp, localFinal);
  console.error(
    `backup: ${localFinal} (concepts=${counts.concept} lineage=${counts.lineage} handoffs=${counts.handoff})`,
  );

  // Offsite. Half of "both" is not "both": a missing destination is an error, not a warning.
  const offsiteDir = resolveOffsiteDir();
  const offsiteParent = dirname(offsiteDir);
  if (!existsSync(offsiteParent)) {
    console.error(`backup: offsite parent missing (${offsiteParent}) — local snapshot kept, pruned nothing`);
    return 1;
  }
  mkdirSync(offsiteDir, { recursive: true });
  const offsiteTmp = join(offsiteDir, `.${name}.tmp`);
  copyFileSync(localFinal, offsiteTmp);
  publish(offsiteTmp, join(offsiteDir, name));
  console.error(`backup: ${join(offsiteDir, name)}`);

  const keep = resolveKeep();
  const dropped = [...prune(localDir, keep), ...prune(offsiteDir, keep)];
  if (dropped.length > 0) console.error(`backup: pruned ${dropped.length} old snapshot(s), keeping ${keep}`);
  return 0;
}

if (import.meta.main) process.exit(main());
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/backup.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Add the `backup` script to `package.json`**

Modify the `scripts` block (`package.json:27-34`) — insert after the `"test"` line:

```json
    "backup": "bun run scripts/backup.ts",
```

- [ ] **Step 6: Run it for real, against the real pool**

Run: `bun run backup`
Expected on stderr, roughly:

```
backup: C:\Users\karim\.workspace\backups\pool-2026-07-09T06-30-00Z.db (concepts=127 lineage=44 handoffs=10)
backup: C:\Users\karim\OneDrive\headwater-backups\pool-2026-07-09T06-30-00Z.db
```

Exit code 0. Then confirm the snapshot is real and complete:

```bash
bun -e 'const {Database}=require("bun:sqlite");
const d=new Database(process.argv[1],{readonly:true});
console.log("integrity:", d.query("PRAGMA integrity_check").get().integrity_check);
console.log("concepts :", d.query("SELECT count(*) AS c FROM concept").get().c);
d.close();' "$HOME/.workspace/backups/$(ls -t ~/.workspace/backups | head -1)"
```

Expected: `integrity: ok` and a concept count matching the live pool.

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/backup.ts tests/backup.test.ts package.json
git commit -m "feat(backup): main() with both destinations and strict exit codes

Local history plus an offsite copy; a missing offsite destination is an
error, not a warning, because half of 'both' is not 'both'. Any failure
publishes nothing new and prunes nothing."
```

---

### Task 4: Documentation and the scheduled task

The script is useless if it never runs, and dangerous if restore is guesswork.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md:57` (insert after the "The repo holds code only" line, before `### Model (six tables)`)

**Interfaces:**
- Consumes: the finished `bun run backup`.
- Produces: no code.

- [ ] **Step 1: Record the new file in `CLAUDE.md`**

In the **Layout (closed file list)** section, append this bullet after the `vendor/mermaid.min.js` entry:

```markdown
- `scripts/backup.ts` — `bun run backup`: snapshot the pool with `VACUUM INTO` over a **read-only**
  connection (a plain `cp` loses un-checkpointed WAL commits and the copy still passes
  `integrity_check`), verify it (`integrity_check` + a monotonic row-count tripwire — the append-only
  tables can never shrink), then publish timestamped copies to `<data dir>/backups/` and to
  `$HEADWATER_BACKUP_DIR` (default `~/OneDrive/headwater-backups/`), pruning both to the newest 14.
  Any failure publishes nothing new and prunes nothing. A recorded, operator-approved addition;
  `tests/backup.test.ts` covers it. **Restore is a documented manual procedure (README) — never
  scripted**, because its dangerous step (stop every writer) is one no script can verify.
```

- [ ] **Step 2: Add `bun run backup` to the `CLAUDE.md` **Run** section**

Change the Run bullet to include it:

```markdown
- `bun run start` — MCP server (stdio). `bun run render` — write `index.html`. `bun run serve` — live viewer
  with a Refresh button. `bun run backup` — verified pool snapshot → local history + offsite. `bun test` — tests.
```

- [ ] **Step 3: Add the restore procedure to `README.md`**

Insert after `README.md:57` (the line `The repo holds code only — the pool, \`*.db\`, and the generated \`index.html\` are git-ignored.`) and before `### Model (six tables)`:

````markdown
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
`HEADWATER_BACKUP_KEEP`. Any failure exits non-zero, publishes nothing new, and prunes nothing.

> **Do not back up the pool with `cp pool.db`.** The pool is in WAL mode, so committed transactions sit
> in `pool.db-wal` until a checkpoint. A file copy silently omits them — and the result still passes
> `integrity_check`, so it looks fine until you need it.

Run it daily with Task Scheduler:

```
schtasks /Create /TN "headwater-backup" /F /SC DAILY /ST 09:00 /RL LIMITED ^
  /TR "\"%USERPROFILE%\.bun\bin\bun.exe\" run \"D:\Repository\headwater\scripts\backup.ts\""
```

If the machine is asleep at the scheduled time the run is skipped; `schtasks` cannot set *"run task as
soon as possible after a missed start"*, so enable that once in the Task Scheduler GUI
(task → Properties → Settings).

#### Restoring

A snapshot is a complete, standalone database, so restoring is a copy — with one footgun. **If a stale
`pool.db-wal` is left beside the restored file, SQLite replays it on next open** and silently
reintroduces the state you were trying to escape. Deleting the sidecars is not optional.

1. Stop every writer: `bun run serve`, and every MCP client (Claude Code, Claude Desktop).
2. Move the current pool aside: `mv ~/.workspace/pool.db ~/.workspace/pool.db.pre-restore`
3. **Delete `~/.workspace/pool.db-wal` and `~/.workspace/pool.db-shm`.**
4. Copy the chosen snapshot into place: `cp ~/.workspace/backups/pool-<stamp>.db ~/.workspace/pool.db`
5. Verify: `bun -e 'const {Database}=require("bun:sqlite"); const d=new Database(process.env.HOME+"/.workspace/pool.db",{readonly:true}); console.log(d.query("PRAGMA integrity_check").get(), d.query("SELECT count(*) AS c FROM concept").get());'`
6. Restart `serve` and your clients.

This is deliberately manual: restore is rare, and step 1 is something no script can verify.
````

- [ ] **Step 4: Verify the docs are accurate**

Run: `bun run backup` once more and confirm the paths in the README match the observed stderr output. Confirm `bun test` still passes (docs changes cannot break it, but the suite is the gate).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(backup): record scripts/backup.ts and the manual restore procedure

Restore stays manual on purpose: its dangerous step, stopping every
writer, is one no script can verify. Documents the stale-WAL footgun."
```

- [ ] **Step 6: Register the scheduled task (operator action, not the agent's)**

Do **not** run `schtasks` on the operator's behalf — creating a scheduled task is a persistent, outward-facing change to their machine. Print the exact command from the README and let the operator run it, then have them enable "run as soon as possible after a missed start" in the GUI.

---

## Post-implementation

- [ ] Record the outcome in the pool with `fork_concept` off `back-up-the-pool-with-read-only-vacuum-into-local-history-onedrive-offsite-daily-eca86176`, `kind=supersedes`, type `note`, titled "Shipped: pool backup" — with the commit SHAs, the observed first-run output, and the retention/exit-code behaviour as built. Closure is derived; do not attempt a status update.
- [ ] Sanity-check that `~/OneDrive/headwater-backups/` actually syncs (OneDrive icon shows uploaded, not pending). An offsite copy that never leaves the disk is not an offsite copy.
