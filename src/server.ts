// server.ts — the eight headwater MCP tools.
//
// The tool *logic* lives here as plain exported functions (writeConcept, forkConcept,
// readConcept, readProjectState, openHandoff, returnHandoff). They take a Database plus a
// snake_case args object that mirrors the tool's input contract exactly, so they can be
// driven straight from tests without any MCP plumbing. `registerTools` wires each into an
// McpServer with a zod input schema; `startServer` runs it over a stdio transport.
//
// Enforced invariants: concepts are never UPDATEd (a fork is a new row + a lineage edge);
// the original parent is untouched by a fork; a handoff's payload_snapshot and directive are
// frozen at creation — only status/returned_at/return_note move in place.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  initDb,
  genId,
  nowIso,
  slugify,
  resolveDataDir,
  CONCEPT_TYPES,
  CONCEPT_STATUSES,
  LINEAGE_KINDS,
  LINEAGE_REASONS,
} from "./db.ts";
import type {
  ConceptRow,
  ConceptStatus,
  ConceptType,
  HandoffRow,
  LineageKind,
  LineageReason,
  ProjectRow,
  SurfaceRow,
} from "./db.ts";

// --- Default kind for surfaces upserted by a write tool (v1 simplification: no tool
// carries a surface kind yet). See CLAUDE.md.
const DEFAULT_SURFACE_KIND = "external_agent" as const;

// --- Tool argument contracts (mirror the zod input schemas below) ----------

export interface WriteConceptArgs {
  project: string;
  type: ConceptType;
  title: string;
  body: string;
  status?: ConceptStatus;
  surface: string;
}

export interface ForkConceptArgs {
  parent_id: string;
  body: string;
  surface: string;
  kind?: LineageKind;
  reason?: LineageReason | null;
  type?: ConceptType;
  title?: string | null;
}

export interface OpenHandoffArgs {
  project: string;
  from_surface: string;
  to_surface: string;
  concept_ids: string[];
  directive: string;
}

export interface ReturnHandoffArgs {
  handoff_id: string;
  return_note: string;
}

/** A concept as the kickoff presents it: the row minus `body`, plus a bounded `body_preview`. */
export type ConceptSummary = Omit<ConceptRow, "body"> & { body_preview: string; closed_by?: ClosedBy };

/** A concept as recents present it: identity only — the full summary already sits in concepts_by_status. */
export type ConceptHead = Pick<ConceptRow, "id" | "type" | "title" | "status" | "created_at"> & {
  closed_by?: ClosedBy;
};

/** How a concept was derived-closed: the closing fork's id and which rule fired. */
export type ClosedBy = { concept_id: string; via: "supersedes" | "decision" };

export interface ProjectState {
  project: string;
  exists: boolean;
  name: string;
  concepts_by_status: Record<ConceptStatus, ConceptSummary[]>;
  open_handoffs: Array<Record<string, unknown>>;
  recent_handoffs: Array<Record<string, unknown>>;
  recent_concepts: ConceptHead[];
}

// --- Internal helpers -------------------------------------------------------

/** Upsert a project by id = slug(name). First mention wins (name/created_at kept on conflict). */
function upsertProject(db: Database, project: string): ProjectRow {
  const id = slugify(project);
  db.query(
    `INSERT INTO project (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, project, null, nowIso());
  return db.query<ProjectRow, [string]>(`SELECT * FROM project WHERE id = ?`).get(id)!;
}

/** Upsert a surface by id = slug(id-or-label). Upserted surfaces get the default kind. */
function upsertSurface(db: Database, surface: string): SurfaceRow {
  const id = slugify(surface);
  db.query(
    `INSERT INTO surface (id, kind, label) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, DEFAULT_SURFACE_KIND, surface);
  return db.query<SurfaceRow, [string]>(`SELECT * FROM surface WHERE id = ?`).get(id)!;
}

function getConcept(db: Database, id: string): ConceptRow | null {
  return db.query<ConceptRow, [string]>(`SELECT * FROM concept WHERE id = ?`).get(id);
}

function getHandoff(db: Database, id: string): HandoffRow | null {
  return db.query<HandoffRow, [string]>(`SELECT * FROM handoff WHERE id = ?`).get(id);
}

/** Parse a handoff's frozen JSON snapshot back into structured form for presentation. */
function presentHandoff(row: HandoffRow): Record<string, unknown> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.payload_snapshot);
  } catch {
    snapshot = row.payload_snapshot;
  }
  return { ...row, payload_snapshot: snapshot };
}

// The kickoff is a MAP of the project, not the archive: a mature pool's full bodies overflow a
// client's context budget, so read_project_state ships bounded previews and read_concept(id)
// remains the full-recall path. Presentation only — stored rows and frozen snapshots are untouched.
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

// Closing edge kinds for the open_question-answered-by-decision rule. annotates (a comment),
// relates_to, and depends_on never close anything.
const CLOSING_KINDS: ReadonlySet<string> = new Set(["forks_from", "evolved_from", "supersedes"]);

/**
 * Derived closure (see pool decision "Closure is derived from lineage, never stored"): concepts
 * reject every UPDATE, so `resolved` is unreachable as a stored transition — closure is computed
 * from lineage instead. A `supersedes` child closes any concept; a `decision` child (via a closing
 * kind) closes an `open_question`. Earliest closing fork wins. Presentation only — stored rows
 * keep their status.
 */
export function computeClosures(db: Database): Map<string, ClosedBy> {
  const rows = db
    .query<{ child: string; parent: string; kind: string; child_type: string; parent_type: string }, []>(
      `SELECT l.from_concept_id AS child, l.to_concept_id AS parent, l.kind,
              cc.type AS child_type, cp.type AS parent_type
         FROM lineage l
         JOIN concept cc ON cc.id = l.from_concept_id
         JOIN concept cp ON cp.id = l.to_concept_id
        ORDER BY l.created_at ASC`,
    )
    .all();
  const closures = new Map<string, ClosedBy>();
  for (const r of rows) {
    if (closures.has(r.parent)) continue; // earliest closing fork wins
    if (r.kind === "supersedes") closures.set(r.parent, { concept_id: r.child, via: "supersedes" });
    else if (r.parent_type === "open_question" && r.child_type === "decision" && CLOSING_KINDS.has(r.kind))
      closures.set(r.parent, { concept_id: r.child, via: "decision" });
  }
  return closures;
}

/** presentHandoff for the kickoff: snapshot concepts carry previews; directive/return_note stay whole. */
function presentHandoffPreview(row: HandoffRow): Record<string, unknown> {
  const presented = presentHandoff(row);
  const snap = presented.payload_snapshot;
  if (Array.isArray(snap)) {
    presented.payload_snapshot = snap.map((c) =>
      c && typeof c === "object" && typeof (c as ConceptRow).body === "string" ? summarize(c as ConceptRow) : c,
    );
  }
  return presented;
}

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

// --- The six operations -----------------------------------------------------

/** Create a new immutable concept; origin_surface_id = the calling surface. */
export function writeConcept(db: Database, args: WriteConceptArgs): ConceptRow {
  const status: ConceptStatus = args.status ?? "active";
  const proj = upsertProject(db, args.project);
  const surf = upsertSurface(db, args.surface);
  const id = genId(args.title);
  const createdAt = nowIso();
  db.query(
    `INSERT INTO concept (id, project_id, type, title, status, body, origin_surface_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, proj.id, args.type, args.title, status, args.body, surf.id, createdAt);
  return getConcept(db, id)!;
}

/**
 * Fork a parent concept: create a NEW immutable concept (same project as the parent, origin =
 * the calling surface) plus a lineage edge from the new node (child) to the parent. The parent
 * row is never modified. Returns the new node.
 */
export function forkConcept(db: Database, args: ForkConceptArgs): ConceptRow {
  const parent = getConcept(db, args.parent_id);
  if (!parent) throw new Error(`unknown parent concept: ${args.parent_id}`);

  const surf = upsertSurface(db, args.surface);
  const type: ConceptType = args.type ?? "note";
  const kind: LineageKind = args.kind ?? "forks_from";
  const reason: LineageReason | null = args.reason ?? null;
  const title = args.title ?? parent.title;
  const status: ConceptStatus = "active";
  const createdAt = nowIso();
  const conceptId = genId(title);
  const lineageId = genId("lineage");

  db.transaction(() => {
    db.query(
      `INSERT INTO concept (id, project_id, type, title, status, body, origin_surface_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(conceptId, parent.project_id, type, title, status, args.body, surf.id, createdAt);
    db.query(
      `INSERT INTO lineage (id, from_concept_id, to_concept_id, kind, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(lineageId, conceptId, parent.id, kind, reason, createdAt);
  })();

  return getConcept(db, conceptId)!;
}

/** Recall a concept by id (a first-class path). Throws if it does not exist. */
export function readConcept(db: Database, id: string): ConceptRow {
  const concept = getConcept(db, id);
  if (!concept) throw new Error(`unknown concept: ${id}`);
  return concept;
}

/** Recall a single handoff by id — the archive path. Snapshot bodies arrive WHOLE: read_project_state
 *  previews returned handoffs, so this is where full recall lives (mirrors read_concept). */
export function readHandoff(db: Database, id: string): Record<string, unknown> {
  const row = getHandoff(db, id);
  if (!row) throw new Error(`unknown handoff: ${id}`);
  return presentHandoff(row);
}

/** Substring search over title+body — plain LIKE, the viewer's ?q= primitive; deliberately not FTS.
 *  Returns kickoff-style summaries (body_preview + closed_by): enough to pick a read_concept target. */
export function findConcepts(
  db: Database,
  args: { project: string; query: string; limit?: number },
): ConceptSummary[] {
  const q = args.query.trim();
  if (q.length === 0) throw new Error("find_concepts requires a non-empty query");
  const limit = Math.min(100, Math.max(1, Math.trunc(args.limit ?? 20)));
  const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .query<ConceptRow, [string, string, string, number]>(
      `SELECT * FROM concept
        WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(slugify(args.project), pattern, pattern, limit);
  const closures = computeClosures(db);
  return rows.map((c) => {
    const s = summarize(c);
    const cb = closures.get(c.id);
    if (cb) s.closed_by = cb;
    return s;
  });
}

/** Session-kickoff context: concepts grouped by status, pending handoffs, and recents. */
export function readProjectState(db: Database, project: string): ProjectState {
  const projectId = slugify(project);
  const projectRow = db
    .query<ProjectRow, [string]>(`SELECT * FROM project WHERE id = ?`)
    .get(projectId);

  const concepts = db
    .query<ConceptRow, [string]>(`SELECT * FROM concept WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId);
  // Bucket by EFFECTIVE status: a derived-closed concept moves out of active/locked/parked into
  // resolved (its summary keeps the stored status + closed_by, so the derivation stays visible).
  const closures = computeClosures(db);
  const byStatus: Record<ConceptStatus, ConceptSummary[]> = {
    active: [],
    locked: [],
    parked: [],
    resolved: [],
    discarded: [],
  };
  for (const c of concepts) {
    const s = summarize(c);
    const cb = closures.get(c.id);
    if (cb) s.closed_by = cb;
    const bucket: ConceptStatus = cb && c.status !== "discarded" && c.status !== "resolved" ? "resolved" : c.status;
    byStatus[bucket].push(s);
  }

  const openHandoffs = db
    .query<HandoffRow, [string]>(
      `SELECT * FROM handoff WHERE project_id = ? AND status = 'pending' ORDER BY initiated_at DESC`,
    )
    .all(projectId);
  const recentHandoffs = db
    .query<HandoffRow, [string]>(
      `SELECT * FROM handoff WHERE project_id = ? AND status <> 'pending' ORDER BY initiated_at DESC LIMIT 10`,
    )
    .all(projectId);
  const recentConcepts = db
    .query<ConceptRow, [string]>(
      `SELECT * FROM concept WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`,
    )
    .all(projectId);

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
}

/**
 * Open a `pending` handoff carrying the named concepts. `payload_snapshot` is a frozen JSON
 * copy of those concept rows at this moment; handoff_concept rows record the join.
 */
export function openHandoff(db: Database, args: OpenHandoffArgs): HandoffRow {
  // A handoff with no concepts carries nothing — a meaningless record. Reject before any upsert so the
  // pool can never hold an empty handoff (guards both the MCP tool and the viewer's form-POST path).
  if (args.concept_ids.length === 0) throw new Error("a handoff must carry at least one concept");
  const proj = upsertProject(db, args.project);
  const fromS = upsertSurface(db, args.from_surface);
  const toS = upsertSurface(db, args.to_surface);

  const carried: ConceptRow[] = [];
  for (const cid of args.concept_ids) {
    const c = getConcept(db, cid);
    if (!c) throw new Error(`unknown concept in handoff: ${cid}`);
    carried.push(c);
  }

  const id = genId("handoff");
  const initiatedAt = nowIso();
  const payload = JSON.stringify(carried);

  db.transaction(() => {
    db.query(
      `INSERT INTO handoff
         (id, project_id, from_surface_id, to_surface_id, directive, payload_snapshot, status, initiated_at, returned_at, return_note)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
    ).run(id, proj.id, fromS.id, toS.id, args.directive, payload, initiatedAt);
    const insertHc = db.query(
      `INSERT INTO handoff_concept (handoff_id, concept_id) VALUES (?, ?)`,
    );
    for (const c of carried) insertHc.run(id, c.id);
  })();

  return getHandoff(db, id)!;
}

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
  // Read-then-write races across processes land on the substrate trigger (a raw "one-way" abort
  // instead of the friendly already_returned no-op). Rare, harmless — the note is never lost.
  db.query(
    `UPDATE handoff SET status = 'returned', returned_at = ?, return_note = ? WHERE id = ?`,
  ).run(nowIso(), args.return_note, args.handoff_id);
  return getHandoff(db, args.handoff_id)!;
}

// --- MCP wiring -------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

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

/** Types whose kickoff previews earn their bytes — the capture protocol's own "worth remembering" set. */
const DURABLE_TYPES: ReadonlySet<string> = new Set(["decision", "architecture", "constraint", "open_question"]);

function toHead(c: ConceptSummary): ConceptHead {
  return {
    id: c.id, type: c.type, title: c.title, status: c.status, created_at: c.created_at,
    ...(c.closed_by ? { closed_by: c.closed_by } : {}),
  };
}

/**
 * The lean kickoff (default): previews for durable-type working-set concepts, heads for note/feature
 * chatter and the whole archive. Measured on the heaviest live project: 82.2 -> 55.9 KB, and note
 * traffic (the chattiest class) stops growing the payload. Handoff/recents sections ride unchanged.
 */
export function leanProjectState(state: ProjectState): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const [status, list] of Object.entries(state.concepts_by_status)) {
    shaped[status] =
      status === "resolved" || status === "discarded"
        ? list.map(toHead)
        : list.map((c) => (DURABLE_TYPES.has(c.type) ? c : toHead(c)));
  }
  return { ...state, mode: "lean", concepts_by_status: shaped };
}

/** Minimal kickoff: heads everywhere + per-status counts. */
export function idsProjectState(state: ProjectState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const shaped: Record<string, unknown> = {};
  for (const [status, list] of Object.entries(state.concepts_by_status)) {
    counts[status] = list.length;
    shaped[status] = list.map(toHead);
  }
  return { ...state, mode: "ids", concept_counts: counts, concepts_by_status: shaped };
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
      case "read_handoff": {
        const row = readHandoff(db, (args as { id: string }).id);
        project = row.project_id as string;
        result = ok(row);
        break;
      }
      case "find_concepts": {
        const a2 = args as { project: string; query: string; limit?: number };
        project = slugify(a2.project);
        result = ok(findConcepts(db, a2));
        break;
      }
      case "read_project_state": {
        const a3 = args as { project: string; mode?: "full" | "lean" | "ids" };
        const state = readProjectState(db, a3.project);
        project = state.project;
        const mode = a3.mode ?? "lean";
        // full stays pretty and byte-identical to the pre-mode output — the back-compat guarantee.
        // lean/ids are compact: an LLM client pays per byte and gains nothing from indentation.
        const text =
          mode === "full"
            ? JSON.stringify(state, null, 2)
            : JSON.stringify(mode === "ids" ? idsProjectState(state) : leanProjectState(state));
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

/** Register all eight tools on the given server, backed by the given pool. */
export function registerTools(server: McpServer, db: Database): void {
  server.registerTool(
    "write_concept",
    {
      title: "Write concept",
      description:
        "Record a new immutable concept in a project. The concept's origin is the calling surface. " +
        "Concepts are never edited in place — to change one, fork it.",
      inputSchema: {
        project: z.string().describe("Project id or name (upserted on first mention)."),
        type: z.enum(CONCEPT_TYPES).describe("Kind of concept."),
        title: z.string().describe("Short human title."),
        body: z.string().describe("The concept's content."),
        status: z.enum(CONCEPT_STATUSES).default("active").describe("Lifecycle status."),
        surface: z.string().describe("Calling surface id or label (upserted)."),
      },
    },
    async (args) => callTool(db, "write_concept", args),
  );

  server.registerTool(
    "fork_concept",
    {
      title: "Fork concept",
      description:
        "Create a new concept derived from a parent, plus a lineage edge from the new node to the " +
        "parent. The parent is never modified. The fork stays in the parent's project; if no title is " +
        "given it carries the parent's title.",
      inputSchema: {
        parent_id: z.string().describe("Id of the concept being forked."),
        body: z.string().describe("The new node's content."),
        surface: z.string().describe("Calling surface id or label (upserted)."),
        kind: z.enum(LINEAGE_KINDS).default("forks_from").describe("Lineage edge kind."),
        reason: z
          .enum(LINEAGE_REASONS)
          .nullable()
          .optional()
          .describe("Why the edge exists (optional)."),
        type: z.enum(CONCEPT_TYPES).default("note").describe("Type of the new concept."),
        title: z.string().nullable().optional().describe("Title for the new node (defaults to parent's)."),
      },
    },
    async (args) => callTool(db, "fork_concept", args),
  );

  server.registerTool(
    "read_concept",
    {
      title: "Read concept",
      description: "Recall a single concept by its id.",
      inputSchema: {
        id: z.string().describe("Concept id."),
      },
    },
    async (args) => callTool(db, "read_concept", args),
  );

  server.registerTool(
    "read_handoff",
    {
      title: "Read handoff",
      description:
        "Recall a single handoff by id — full directive, return note, and the frozen payload snapshot " +
        "with complete concept bodies. read_project_state previews returned handoffs; this is full recall.",
      inputSchema: { id: z.string().describe("Handoff id.") },
    },
    async (args) => callTool(db, "read_handoff", args),
  );

  server.registerTool(
    "find_concepts",
    {
      title: "Find concepts",
      description:
        "Substring search over concept titles and bodies within a project (plain match — % and _ are " +
        "literal). Returns summaries with body_preview and closed_by, newest first. Search first; only " +
        "read_project_state(mode:'full') when you truly need everything.",
      inputSchema: {
        project: z.string().describe("Project id or name."),
        query: z.string().describe("Substring to find in title or body."),
        limit: z.number().int().optional().describe("Max results, 1-100 (default 20)."),
      },
    },
    async (args) => callTool(db, "find_concepts", args),
  );

  server.registerTool(
    "read_project_state",
    {
      title: "Read project state",
      description:
        "Session-kickoff context for a project: concepts grouped by status, open (pending) handoffs, " +
        "and recent handoffs and concepts. In the default lean mode, decisions/architecture/constraints/open questions arrive with bounded previews (body_preview) and other concepts as heads — call read_concept(id) for any full body, or mode:'full' for previews of everything. Default mode is lean — use " +
        "find_concepts/read_concept for anything it elides; mode:'ids' is the minimal map.",
      inputSchema: {
        project: z.string().describe("Project id or name."),
        mode: z
          .enum(["full", "lean", "ids"])
          .default("lean")
          .describe(
            "lean (default): durable-type previews + heads for notes and the archive. " +
              "full: everything with previews (heaviest). ids: heads + counts only.",
          ),
      },
    },
    async (args) => callTool(db, "read_project_state", args),
  );

  server.registerTool(
    "open_handoff",
    {
      title: "Open handoff",
      description:
        "Open a pending handoff from one surface to another carrying a set of concepts. The payload is " +
        "a frozen JSON snapshot of those concepts at this moment; the directive states what the receiver " +
        "should do.",
      inputSchema: {
        project: z.string().describe("Project id or name."),
        from_surface: z.string().describe("Originating surface id or label."),
        to_surface: z.string().describe("Receiving surface id or label."),
        concept_ids: z.array(z.string()).min(1).describe("Concept ids this handoff carries (at least one)."),
        directive: z.string().describe("What the receiving surface should do."),
      },
    },
    async (args) => callTool(db, "open_handoff", args),
  );

  server.registerTool(
    "return_handoff",
    {
      title: "Return handoff",
      description: "Mark a handoff as returned, recording a note about what came back.",
      inputSchema: {
        handoff_id: z.string().describe("Id of the handoff to return."),
        return_note: z.string().describe("What the receiver reports back."),
      },
    },
    async (args) => callTool(db, "return_handoff", args),
  );
}

/** Open the default pool, build the MCP server, and serve over stdio. */
/**
 * Usage guidance returned to EVERY client on `initialize` (the MCP `instructions` field), so any
 * surface — Claude Code, Desktop, Design, other agents — learns how to use headwater without per-session
 * or per-project setup. Kept concise (it rides every connection); the full playbook lives in the pool
 * concept "How to use headwater effectively", which this points at. No backticks: it's a JS template
 * for a plain-text protocol string.
 */
export const SERVER_INSTRUCTIONS = [
  "headwater records how state MOVES between AI surfaces (chats, code sessions, agents) — the handoff, not just the memory.",
  "KICKOFF: before substantive work call read_project_state(<project>) — the default lean mode carries previews for decisions/architecture/constraints/open questions and heads for the rest; read_concept(id) recalls any full text, read_handoff(id) recalls a full handoff (frozen snapshot included). Pin <project> per surface; never infer it from a directory name.",
  "DISCOVER: find_concepts(project, query) substring-searches titles+bodies and returns summaries — search first; request mode:'full' state only when you truly need every preview. mode:'ids' is the minimal map.",
  "CAPTURE: as durable decisions emerge call write_concept — ONLY things worth remembering across sessions (decision, architecture, constraint, open_question), never routine chatter or anything already in code/git. Short imperative title; the body states the decision AND the why. Identify yourself with a stable surface label like 'claude-code:<repo>' or 'claude-desktop:<project>'.",
  "RICH BODIES: a concept body renders a markdown subset (headings, bold/italic/inline code, http links + images, pipe tables, bullet/numbered lists, '- [ ]'/'- [x]' checklists) plus mermaid diagram blocks in the viewer — use them so a concept can express itself, not just plain prose. Cite related concepts and handoffs as [[concept-id]] (the hash suffix is optional): resolved ids render as links, dangling ones as ghosts that flag the missing node.",
  "REVISE BY FORKING: concepts are immutable — never rewrite one. fork_concept off the parent (kind supersedes / evolved_from / annotates) so history stays a linked tree. A maintained list (a task registry) is a concept kept current by supersede-forks, not an edit. CLOSURE IS DERIVED, never stored: a supersedes fork closes its parent, and a decision fork answers an open_question — kickoff and viewer then present the parent as resolved (closed_by names the fork). There is no status-update path; do not look for one.",
  "HAND OFF: open_handoff(concept_ids + directive) passes work to another surface; return_handoff(note) closes the loop. The payload snapshot is frozen at creation; read_handoff(id) recalls it whole. Returning twice is safe: an identical note is a no-op, a different note is refused.",
  "OBSERVE: run 'bun run serve' for a local read-and-write viewer at 127.0.0.1 where the operator can browse, filter, inspect each handoff's frozen-vs-current evidence, and comment/fork/hand off from the page.",
  'Full playbook: read the concept titled "How to use headwater effectively" (surfaced by read_project_state).',
].join("\n\n");

export async function startServer(): Promise<void> {
  const db = initDb();
  const server = new McpServer({ name: "headwater", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio is the protocol channel — diagnostics must go to stderr, never stdout.
  console.error("headwater MCP server running on stdio");
}
