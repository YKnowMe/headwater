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
