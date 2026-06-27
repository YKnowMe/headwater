// db.ts — the authoritative SQLite pool.
//
// Owns: the six-table schema, an idempotent init/connection helper (bun:sqlite),
// resolution of the data directory, and the small id/slug/time helpers used when
// minting rows. Nothing here knows about MCP — it is pure persistence.
//
// Invariants the schema encodes (see CLAUDE.md): concepts are immutable, lineage is
// append-only (child -> parent edges), and a handoff's payload_snapshot + directive
// are frozen at creation. IDs are stable slugs; timestamps are ISO TEXT.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Enumerations: single source of truth ----------------------------------
// These const tuples drive the SQL CHECK constraints (below), the TypeScript row
// types, and the zod tool schemas (in server.ts), so the three can never drift.

export const SURFACE_KINDS = ["desktop_chat", "code_session", "external_agent", "operator"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export const CONCEPT_TYPES = ["decision", "feature", "architecture", "open_question", "constraint", "note"] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const CONCEPT_STATUSES = ["active", "locked", "parked", "resolved", "discarded"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export const LINEAGE_KINDS = ["forks_from", "annotates", "evolved_from", "supersedes", "relates_to", "depends_on"] as const;
export type LineageKind = (typeof LINEAGE_KINDS)[number];

export const LINEAGE_REASONS = ["observation", "inference", "correction"] as const;
export type LineageReason = (typeof LINEAGE_REASONS)[number];

export const HANDOFF_STATUSES = ["pending", "consumed", "returned", "dropped"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

// --- Row types (mirror the table columns exactly) --------------------------

export interface ProjectRow {
  id: string;
  name: string;
  repo_path: string | null;
  created_at: string;
}

export interface SurfaceRow {
  id: string;
  kind: SurfaceKind;
  label: string;
}

export interface ConceptRow {
  id: string;
  project_id: string;
  type: ConceptType;
  title: string;
  status: ConceptStatus;
  body: string;
  origin_surface_id: string;
  created_at: string;
}

export interface LineageRow {
  id: string;
  from_concept_id: string;
  to_concept_id: string;
  kind: LineageKind;
  reason: LineageReason | null;
  created_at: string;
}

export interface HandoffRow {
  id: string;
  project_id: string;
  from_surface_id: string;
  to_surface_id: string;
  directive: string;
  payload_snapshot: string;
  status: HandoffStatus;
  initiated_at: string;
  returned_at: string | null;
  return_note: string | null;
}

export interface HandoffConceptRow {
  handoff_id: string;
  concept_id: string;
}

// --- Data-directory resolution ---------------------------------------------

export const DEFAULT_DB_FILENAME = "pool.db";

/** Directory that holds the pool. `HEADWATER_DATA_DIR` overrides `~/.workspace`. */
export function resolveDataDir(): string {
  const override = process.env.HEADWATER_DATA_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".workspace");
}

/** Absolute path to the pool file (`<data dir>/pool.db`). */
export function resolveDbPath(): string {
  return join(resolveDataDir(), DEFAULT_DB_FILENAME);
}

// --- Schema -----------------------------------------------------------------

/** Render a CHECK ... IN (...) value list from an enum tuple. */
function inClause(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(", ");
}

function schemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS project (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      repo_path   TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS surface (
      id     TEXT PRIMARY KEY,
      kind   TEXT NOT NULL CHECK (kind IN (${inClause(SURFACE_KINDS)})),
      label  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS concept (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES project(id),
      type              TEXT NOT NULL CHECK (type IN (${inClause(CONCEPT_TYPES)})),
      title             TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN (${inClause(CONCEPT_STATUSES)})),
      body              TEXT NOT NULL,
      origin_surface_id TEXT NOT NULL REFERENCES surface(id),
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lineage (
      id              TEXT PRIMARY KEY,
      from_concept_id TEXT NOT NULL REFERENCES concept(id),
      to_concept_id   TEXT NOT NULL REFERENCES concept(id),
      kind            TEXT NOT NULL CHECK (kind IN (${inClause(LINEAGE_KINDS)})),
      reason          TEXT CHECK (reason IN (${inClause(LINEAGE_REASONS)})),
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handoff (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES project(id),
      from_surface_id  TEXT NOT NULL REFERENCES surface(id),
      to_surface_id    TEXT NOT NULL REFERENCES surface(id),
      directive        TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN (${inClause(HANDOFF_STATUSES)})),
      initiated_at     TEXT NOT NULL,
      returned_at      TEXT,
      return_note      TEXT
    );

    CREATE TABLE IF NOT EXISTS handoff_concept (
      handoff_id TEXT NOT NULL REFERENCES handoff(id),
      concept_id TEXT NOT NULL REFERENCES concept(id),
      PRIMARY KEY (handoff_id, concept_id)
    );

    CREATE INDEX IF NOT EXISTS idx_concept_project   ON concept(project_id);
    CREATE INDEX IF NOT EXISTS idx_handoff_project   ON handoff(project_id);
    CREATE INDEX IF NOT EXISTS idx_lineage_parent    ON lineage(to_concept_id);
    CREATE INDEX IF NOT EXISTS idx_lineage_child     ON lineage(from_concept_id);
    CREATE INDEX IF NOT EXISTS idx_hc_concept        ON handoff_concept(concept_id);

    -- Invariants enforced at the SUBSTRATE, not just in the tools: a raw \`sqlite3 pool.db "UPDATE ..."\`
    -- is rejected too, so the integrity claim is literally true of the file. Concepts are immutable,
    -- lineage + handoff_concept are append-only, and a handoff is frozen except its return transition.
    CREATE TRIGGER IF NOT EXISTS concept_immutable_update
      BEFORE UPDATE ON concept
      BEGIN SELECT RAISE(ABORT, 'concept is immutable: never UPDATE a concept — fork it instead'); END;
    CREATE TRIGGER IF NOT EXISTS concept_immutable_delete
      BEFORE DELETE ON concept
      BEGIN SELECT RAISE(ABORT, 'concept is immutable: never DELETE a concept'); END;

    CREATE TRIGGER IF NOT EXISTS lineage_append_only_update
      BEFORE UPDATE ON lineage
      BEGIN SELECT RAISE(ABORT, 'lineage is append-only: never UPDATE a lineage edge'); END;
    CREATE TRIGGER IF NOT EXISTS lineage_append_only_delete
      BEFORE DELETE ON lineage
      BEGIN SELECT RAISE(ABORT, 'lineage is append-only: never DELETE a lineage edge'); END;

    CREATE TRIGGER IF NOT EXISTS handoff_concept_append_only_update
      BEFORE UPDATE ON handoff_concept
      BEGIN SELECT RAISE(ABORT, 'handoff_concept is append-only: never UPDATE a carried-concept row'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_concept_append_only_delete
      BEFORE DELETE ON handoff_concept
      BEGIN SELECT RAISE(ABORT, 'handoff_concept is append-only: never DELETE a carried-concept row'); END;

    -- A handoff's frozen fields never move; only status / returned_at / return_note may change.
    CREATE TRIGGER IF NOT EXISTS handoff_frozen_update
      BEFORE UPDATE ON handoff
      WHEN OLD.id               <> NEW.id
        OR OLD.project_id       <> NEW.project_id
        OR OLD.from_surface_id  <> NEW.from_surface_id
        OR OLD.to_surface_id    <> NEW.to_surface_id
        OR OLD.directive        <> NEW.directive
        OR OLD.payload_snapshot <> NEW.payload_snapshot
        OR OLD.initiated_at     <> NEW.initiated_at
      BEGIN SELECT RAISE(ABORT, 'handoff is frozen: only status/returned_at/return_note may change'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_no_delete
      BEFORE DELETE ON handoff
      BEGIN SELECT RAISE(ABORT, 'handoff is immutable: never DELETE a handoff'); END;
  `;
}

// --- Connection / init ------------------------------------------------------

/** Bump when the schema changes. Gates one-time DDL via PRAGMA user_version. v2 adds the immutability
 *  triggers; because schemaSql() uses IF NOT EXISTS throughout, an existing v1 pool gains them on its
 *  next open (re-running the DDL is a no-op for the tables/indexes and just creates the new triggers). */
const SCHEMA_VERSION = 2;

/**
 * Create the schema exactly once per pool, atomically. The pool is shared across processes (one MCP
 * server per session), so a version gate means only the first opener ever runs DDL — every later
 * open skips it, taking no write lock. Without this, concurrent opens on a fresh pool interleave
 * their CREATE statements and one connection sees a half-built schema ("no such table"), crashing it.
 */
function ensureSchema(db: Database): void {
  const current = db.query<{ user_version: number }, []>(`PRAGMA user_version`).get();
  if ((current?.user_version ?? 0) >= SCHEMA_VERSION) return; // already initialized — no DDL, no lock
  db.transaction(() => {
    db.exec(schemaSql());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  })();
}

/**
 * Open (creating if needed) the pool at `dbPath` and ensure the schema exists.
 * Idempotent: safe to call on every startup, including concurrently from multiple processes.
 * Pass `":memory:"` or a temp path in tests. Creates the data directory when it is a real file.
 */
export function initDb(dbPath: string = resolveDbPath()): Database {
  if (dbPath !== ":memory:") {
    const dir = join(dbPath, "..");
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  // The pool is shared by every session's MCP server. Wait for a contended lock (up to 5s) instead
  // of erroring immediately, so sustained write bursts across processes serialize rather than crash.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  ensureSchema(db);
  return db;
}

// --- ID / slug / time helpers ----------------------------------------------

/** Lowercase, collapse non-alphanumerics to single hyphens, trim. Falls back to "item". */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "item";
}

/** Short, collision-resistant suffix derived from a UUID. */
export function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** A stable, human-readable id: `<slug(base)>-<shortId>`. */
export function genId(base: string): string {
  return `${slugify(base)}-${shortId()}`;
}

/** Current time as an ISO 8601 string (the storage format for all timestamps). */
export function nowIso(): string {
  return new Date().toISOString();
}
