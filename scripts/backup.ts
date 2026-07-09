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
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDataDir, resolveDbPath } from "../src/db.ts";

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
