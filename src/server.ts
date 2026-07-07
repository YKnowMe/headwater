// server.ts — the six headwater MCP tools.
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
import {
  initDb,
  genId,
  nowIso,
  slugify,
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
export type ConceptSummary = Omit<ConceptRow, "body"> & { body_preview: string };

export interface ProjectState {
  project: string;
  exists: boolean;
  name: string;
  concepts_by_status: Record<ConceptStatus, ConceptSummary[]>;
  open_handoffs: Array<Record<string, unknown>>;
  recent_handoffs: Array<Record<string, unknown>>;
  recent_concepts: ConceptSummary[];
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

function summarize(c: ConceptRow): ConceptSummary {
  const { body, ...rest } = c;
  const flat = body.replace(/\s+/g, " ").trim();
  return { ...rest, body_preview: flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + "…" : flat };
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

/** Session-kickoff context: concepts grouped by status, pending handoffs, and recents. */
export function readProjectState(db: Database, project: string): ProjectState {
  const projectId = slugify(project);
  const projectRow = db
    .query<ProjectRow, [string]>(`SELECT * FROM project WHERE id = ?`)
    .get(projectId);

  const concepts = db
    .query<ConceptRow, [string]>(`SELECT * FROM concept WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId);
  const byStatus: Record<ConceptStatus, ConceptSummary[]> = {
    active: [],
    locked: [],
    parked: [],
    resolved: [],
    discarded: [],
  };
  for (const c of concepts) byStatus[c.status].push(summarize(c));

  const openHandoffs = db
    .query<HandoffRow, [string]>(
      `SELECT * FROM handoff WHERE project_id = ? AND status = 'pending' ORDER BY initiated_at DESC`,
    )
    .all(projectId);
  const recentHandoffs = db
    .query<HandoffRow, [string]>(
      `SELECT * FROM handoff WHERE project_id = ? ORDER BY initiated_at DESC LIMIT 10`,
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
    recent_handoffs: recentHandoffs.map(presentHandoffPreview),
    recent_concepts: recentConcepts.map(summarize),
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

/** Move a handoff to `returned`, stamping returned_at and the return note. */
export function returnHandoff(db: Database, args: ReturnHandoffArgs): HandoffRow {
  const existing = getHandoff(db, args.handoff_id);
  if (!existing) throw new Error(`unknown handoff: ${args.handoff_id}`);
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

/** Register all six tools on the given server, backed by the given pool. */
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
    async (args) => {
      try {
        return ok(writeConcept(db, args));
      } catch (err) {
        return fail(err);
      }
    },
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
    async (args) => {
      try {
        return ok(forkConcept(db, args));
      } catch (err) {
        return fail(err);
      }
    },
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
    async (args) => {
      try {
        return ok(readConcept(db, args.id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read_project_state",
    {
      title: "Read project state",
      description:
        "Session-kickoff context for a project: concepts grouped by status, open (pending) handoffs, " +
        "and recent handoffs and concepts. Concept bodies arrive as bounded previews (body_preview) — " +
        "call read_concept(id) for any full body you need.",
      inputSchema: {
        project: z.string().describe("Project id or name."),
      },
    },
    async (args) => {
      try {
        return ok(readProjectState(db, args.project));
      } catch (err) {
        return fail(err);
      }
    },
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
    async (args) => {
      try {
        return ok(presentHandoff(openHandoff(db, args)));
      } catch (err) {
        return fail(err);
      }
    },
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
    async (args) => {
      try {
        return ok(presentHandoff(returnHandoff(db, args)));
      } catch (err) {
        return fail(err);
      }
    },
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
  "KICKOFF: before substantive work call read_project_state(<project>) to load prior decisions, open questions, and pending handoffs. Bodies arrive as bounded previews — read_concept(id) recalls any full text. Pin <project> per surface; never infer it from a directory name.",
  "CAPTURE: as durable decisions emerge call write_concept — ONLY things worth remembering across sessions (decision, architecture, constraint, open_question), never routine chatter or anything already in code/git. Short imperative title; the body states the decision AND the why. Identify yourself with a stable surface label like 'claude-code:<repo>' or 'claude-desktop:<project>'.",
  "RICH BODIES: a concept body renders a markdown subset (headings, bold/italic/inline code, http links + images, pipe tables, bullet/numbered lists, '- [ ]'/'- [x]' checklists) plus mermaid diagram blocks in the viewer — use them so a concept can express itself, not just plain prose. Cite related concepts and handoffs as [[concept-id]] (the hash suffix is optional): resolved ids render as links, dangling ones as ghosts that flag the missing node.",
  "REVISE BY FORKING: concepts are immutable — never rewrite one. fork_concept off the parent (kind supersedes / evolved_from / annotates) so history stays a linked tree. A maintained list (a task registry) is a concept kept current by supersede-forks, not an edit.",
  "HAND OFF: open_handoff(concept_ids + directive) passes work to another surface; return_handoff(note) closes the loop. The payload snapshot is frozen at creation.",
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
