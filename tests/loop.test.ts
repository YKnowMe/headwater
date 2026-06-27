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
import { initDb, resolveDataDir } from "../src/db.ts";
import {
  writeConcept,
  readConcept,
  forkConcept,
  openHandoff,
  returnHandoff,
  readProjectState,
  SERVER_INSTRUCTIONS,
} from "../src/server.ts";
import { renderHtml, handleViewerRequest, startViewer } from "../src/render.ts";

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

// --- render.ts: the observation page groups by project and tames long bodies ---

test("render groups concepts by project and never bleeds across projects", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "headwater", type: "note", title: "HEADWATER_ONLY_TITLE", body: "hw body", surface: "code" });
  writeConcept(rdb, { project: "threadkey", type: "note", title: "THREADKEY_ONLY_TITLE", body: "tk body", surface: "code" });

  const html = renderHtml(rdb);

  // each project gets its own anchored section
  const iHw = html.indexOf('id="proj-headwater"');
  const iTk = html.indexOf('id="proj-threadkey"');
  expect(iHw).toBeGreaterThan(-1);
  expect(iTk).toBeGreaterThan(-1);
  expect(iHw).toBeLessThan(iTk); // sorted by name: headwater before threadkey

  // the bug we are fixing: a project's concept must not appear under another project
  const hwChunk = html.slice(iHw, iTk);
  const tkChunk = html.slice(iTk);
  expect(hwChunk).toContain("HEADWATER_ONLY_TITLE");
  expect(hwChunk).not.toContain("THREADKEY_ONLY_TITLE");
  expect(tkChunk).toContain("THREADKEY_ONLY_TITLE");
  expect(tkChunk).not.toContain("HEADWATER_ONLY_TITLE");

  rdb.close();
});

test("live viewer scopes to a single project via the `only` filter", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "headwater", type: "note", title: "HEADWATER_ONLY_TITLE", body: "hw", surface: "code" });
  writeConcept(rdb, { project: "threadkey", type: "note", title: "THREADKEY_ONLY_TITLE", body: "tk", surface: "code" });

  const scoped = renderHtml(rdb, { live: true, only: "threadkey" });

  // only the requested project's section renders
  expect(scoped).toContain('id="proj-threadkey"');
  expect(scoped).not.toContain('id="proj-headwater"');
  expect(scoped).toContain("THREADKEY_ONLY_TITLE");
  expect(scoped).not.toContain("HEADWATER_ONLY_TITLE");

  rdb.close();
});

test("long concept bodies collapse and stay bounded; short ones stay plain paragraphs", () => {
  const rdb = initDb(":memory:");
  const longBody = "L".repeat(300);
  writeConcept(rdb, { project: "p", type: "note", title: "LONG_ONE", body: longBody, surface: "code" });
  writeConcept(rdb, { project: "p", type: "note", title: "SHORT_ONE", body: "short body", surface: "code" });

  const html = renderHtml(rdb);

  // long body -> collapsible disclosure whose full region is height-bounded (no card can dominate)
  expect(html).toContain('<details class="card-body">');
  expect(html).toContain('class="body-full"');
  expect(html).toContain("L".repeat(300)); // full text is still present, just collapsed
  expect(html).toMatch(/\.body-full[^}]*max-height/); // expanded body is capped via CSS

  // short body -> plain card-body container (no needless disclosure triangle)
  expect(html).toContain('<div class="card-body">short body</div>');

  rdb.close();
});

// --- render.ts: rich concept bodies (escape-first markdown subset + mermaid) ---

test("rich body renders image URLs as <img>; non-http schemes never reach an attribute", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "img", body: "see ![d](https://ex.com/a.png) ok", surface: "s" });
  writeConcept(rdb, { project: "p", type: "note", title: "bad", body: "x ![e](javascript:alert(1)) y", surface: "s" });
  const html = renderHtml(rdb);
  expect(html).toContain('<img src="https://ex.com/a.png"');
  expect(html).toContain('loading="lazy"');
  expect(html).not.toContain('src="javascript:');
  expect(html).not.toContain('href="javascript:');
  rdb.close();
});

test("rich body renders bold, code, http links, and pipe tables", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "fmt", body: "**bold** and `code` and [t](https://ex.com)", surface: "s" });
  writeConcept(rdb, { project: "p", type: "note", title: "tbl", body: "| a | b |\n| - | - |\n| 1 | 2 |", surface: "s" });
  const html = renderHtml(rdb);
  expect(html).toContain("<b>bold</b>");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain('<a href="https://ex.com" rel="noopener noreferrer"');
  expect(html).toContain('<table class="md">');
  rdb.close();
});

test("rich body is injection-safe: raw HTML in a body is escaped, never executable", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "xss", body: '<script>alert(1)</script> <img src=x onerror=alert(2)>', surface: "s" });
  const html = renderHtml(rdb);
  expect(html).not.toContain("<script>alert(1)"); // no raw script tag
  expect(html).not.toContain("<img src=x onerror"); // no raw injected img
  expect(html).toContain("&lt;script&gt;"); // it is escaped text
  rdb.close();
});

test("rich body blocks js-scheme and attribute-breakout injection vectors", () => {
  const rdb = initDb(":memory:");
  const nasties = [
    "[x](javascript:alert(1))",
    "![y](javascript:alert(2))",
    '[z](https://e.com" onmouseover="alert(3))',
    '![w](https://e.com/"><script>alert(4)</script>)',
    'plain <b onclick="x">no</b> and <a href="javascript:1">no</a>',
  ];
  nasties.forEach((b, i) => writeConcept(rdb, { project: "p", type: "note", title: `n${i}`, body: b, surface: "s" }));
  const html = renderHtml(rdb); // static => no mermaid <script> to confuse the assertions
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="javascript:');
  expect(html).not.toContain('onmouseover="alert');
  expect(html).not.toContain('onclick="x"');
  expect(html).not.toContain("<script>alert(4)");
  rdb.close();
});

// --- render.ts Phase 3: live-only filters + plain-LIKE search ---

test("live filter ?type= scopes concepts via parameterized SQL", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "decision", title: "DECISION_ONE", body: "d", surface: "s" });
  writeConcept(rdb, { project: "p", type: "note", title: "NOTE_ONE", body: "n", surface: "s" });
  const html = renderHtml(rdb, { live: true, filters: { type: "decision" } });
  expect(html).toContain("DECISION_ONE");
  expect(html).not.toContain("NOTE_ONE");
  rdb.close();
});

test("live filter ?q= matches a title/body substring (LIKE, case-insensitive)", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "alpha", body: "find the WIDGET here", surface: "s" });
  writeConcept(rdb, { project: "p", type: "note", title: "beta", body: "nothing", surface: "s" });
  const html = renderHtml(rdb, { live: true, filters: { q: "widget" } });
  expect(html).toContain("alpha");
  expect(html).not.toContain("beta");
  rdb.close();
});

test("filter bar + GET search render only in the live viewer (static stays form-free)", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "decision", title: "A", body: "a", surface: "s" });
  const live = renderHtml(rdb, { live: true });
  const stat = renderHtml(rdb);
  expect(live).toContain('class="filter-bar"');
  expect(live).toContain('name="q"');
  expect(stat).not.toContain('class="filter-bar"');
  expect(stat).not.toContain("<form");
  rdb.close();
});

test("mermaid blocks render live as <pre class=\"mermaid\"> with the script; static as a code block", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "m", body: "```mermaid\ngraph TD; A-->B;\n```", surface: "s" });
  const live = renderHtml(rdb, { live: true });
  const stat = renderHtml(rdb);
  expect(live).toContain('<pre class="mermaid">');
  expect(live).toContain("/vendor/mermaid.min.js");
  expect(stat).not.toContain('<pre class="mermaid">');
  expect(stat).toContain('class="code-block"');
  expect(stat).not.toContain("/vendor/mermaid.min.js");
  rdb.close();
});

// --- db.ts: the shared pool must survive concurrent opens by multiple server processes ---

test("initDb sets a busy_timeout so concurrent processes wait for the lock instead of crashing", () => {
  const probe = initDb(":memory:");
  const row = probe.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!;
  expect(row.timeout).toBeGreaterThan(0);
  probe.close();
});

test("initDb stamps a schema version and re-initialising an existing pool runs no DDL (lock-free)", () => {
  const dir = mkdtempSync(join(tmpdir(), "headwater-init-"));
  const path = join(dir, "pool.db");
  const a = initDb(path);
  // schema is marked initialized, so future opens can skip DDL entirely
  const v = a.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  expect(v).toBeGreaterThan(0);

  // hold a write lock, then open the SAME (already-initialized) pool: it must not need a write
  // lock (no DDL) and must not throw — this is what a second server process does.
  a.exec("BEGIN IMMEDIATE");
  a.query("INSERT INTO surface (id, kind, label) VALUES ('lockholder', 'operator', 'lock')").run();
  expect(() => {
    const b = initDb(path);
    b.close();
  }).not.toThrow();
  a.exec("ROLLBACK");
  a.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- render.ts Phase 1: readability/density on a clogged page ---

test("render shows an overview header with pool scale and per-status tallies", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "decision", title: "A", body: "a", surface: "s", status: "active" });
  writeConcept(rdb, { project: "p", type: "note", title: "B", body: "b", surface: "s", status: "locked" });
  const html = renderHtml(rdb);
  expect(html).toContain('class="overview"');
  expect(html).toContain("2 concepts");
  const overview = html.slice(html.indexOf('class="overview"'), html.indexOf('class="overview"') + 500);
  expect(overview).toContain("st-active");
  expect(overview).toContain("st-locked");
  rdb.close();
});

test("render collapses projects by default once there are more than 3", () => {
  const rdb = initDb(":memory:");
  for (const name of ["a", "b", "c", "d"]) {
    writeConcept(rdb, { project: name, type: "note", title: `t-${name}`, body: "x", surface: "s" });
  }
  const html = renderHtml(rdb);
  expect(html).not.toMatch(/<details class="project"[^>]*\sopen>/);
  rdb.close();
});

test("render keeps projects expanded when there are 3 or fewer", () => {
  const rdb = initDb(":memory:");
  for (const name of ["a", "b"]) {
    writeConcept(rdb, { project: name, type: "note", title: `t-${name}`, body: "x", surface: "s" });
  }
  const html = renderHtml(rdb);
  expect(html).toMatch(/<details class="project"[^>]*\sopen>/);
  rdb.close();
});

test("render caps a long status group and tucks the rest behind 'show more'", () => {
  const rdb = initDb(":memory:");
  for (let i = 0; i < 15; i++) {
    writeConcept(rdb, { project: "p", type: "note", title: `c${i}`, body: "b", surface: "s" });
  }
  const html = renderHtml(rdb);
  expect(html).toContain('<details class="more">');
  expect(html).toContain("Show 3 more"); // 15 - 12 cap
  rdb.close();
});

// --- render.ts Phase 2: tables, inline-SVG diagrams, schema panel (collapsed on-demand views) ---

test("render includes a schema panel listing the six tables with live counts", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "A", body: "a", surface: "s" });
  const html = renderHtml(rdb);
  expect(html).toContain('<details class="schema">');
  expect(html).toContain("<code>handoff_concept</code>"); // unique to the schema panel
  rdb.close();
});

test("render adds a lineage SVG diagram and an adjacency table when edges exist", () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Parent", body: "p", surface: "s" });
  forkConcept(rdb, { parent_id: parent.id, body: "child body", surface: "s", title: "Child" });
  const html = renderHtml(rdb);
  expect(html).toContain('class="lineage-svg"');
  expect(html).toContain('<table class="ltbl">');
  rdb.close();
});

test("render adds a handoff table and an SVG timeline when handoffs exist", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "A", body: "a", surface: "s1" });
  openHandoff(rdb, { project: "p", from_surface: "s1", to_surface: "s2", concept_ids: [a.id], directive: "do x" });
  const html = renderHtml(rdb);
  expect(html).toContain('<table class="htbl">');
  expect(html).toContain('class="timeline-svg"');
  rdb.close();
});

test("render adds a type x status matrix per project", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "decision", title: "A", body: "a", surface: "s", status: "active" });
  const html = renderHtml(rdb);
  expect(html).toContain('<table class="matrix">');
  rdb.close();
});

test("lineage representations form an exclusive switch (one open at a time, tree by default)", () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Parent", body: "p", surface: "s" });
  forkConcept(rdb, { parent_id: parent.id, body: "c", surface: "s", title: "Child" });
  const html = renderHtml(rdb);
  // three views share one <details name> group -> native exclusive switch; the tree is open by default
  const grouped = html.match(/<details class="view" name="lin-[^"]+"/g) ?? [];
  expect(grouped.length).toBe(3);
  expect(html).toMatch(/<details class="view" name="lin-[^"]+" open><summary>Tree<\/summary>/);
  rdb.close();
});

test("handoff representations form an exclusive switch (cards by default)", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "A", body: "a", surface: "s1" });
  openHandoff(rdb, { project: "p", from_surface: "s1", to_surface: "s2", concept_ids: [a.id], directive: "do x" });
  const html = renderHtml(rdb);
  const grouped = html.match(/<details class="view" name="ho-[^"]+"/g) ?? [];
  expect(grouped.length).toBe(3); // cards | table | timeline
  expect(html).toMatch(/<details class="view" name="ho-[^"]+" open><summary>Cards<\/summary>/);
  rdb.close();
});

// --- Phase 5: the live-viewer write surface (forms -> server.ts functions -> 303 PRG) -------------
// The live viewer gains native <form> POST actions that call the SAME exported server.ts functions the
// MCP tools use, so every invariant holds: a "comment" is an `annotates` fork (never an UPDATE), a fork
// adds a child->parent edge, a handoff freezes its snapshot. Static `bun run render` stays form-free.
// handleViewerRequest is a pure (Request, db) -> Response unit, tested without binding a socket.

function writePost(path: string, fields: Record<string, string>, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

test("POST /w/fork creates a forks_from child, 303-redirects, and never touches the parent", async () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Root", body: "root body", surface: "s" });
  const res = await handleViewerRequest(writePost("/w/fork", { parent_id: parent.id, body: "a branch" }), rdb);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("project=p");
  const edge = rdb.query<{ kind: string }, [string]>("SELECT kind FROM lineage WHERE to_concept_id = ?").get(parent.id);
  expect(edge?.kind).toBe("forks_from");
  expect(readConcept(rdb, parent.id)).toEqual(parent); // immutable: parent row unchanged
  rdb.close();
});

test("POST /w/comment annotates via a fork — a new node + edge, the parent byte-identical", async () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Root", body: "root", surface: "s" });
  const countBefore = rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM concept").get()!.n;
  const res = await handleViewerRequest(writePost("/w/comment", { parent_id: parent.id, body: "good point" }), rdb);
  expect(res.status).toBe(303);
  const edge = rdb.query<{ kind: string }, [string]>("SELECT kind FROM lineage WHERE to_concept_id = ?").get(parent.id);
  expect(edge?.kind).toBe("annotates"); // a comment is a fork, never an UPDATE
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM concept").get()!.n).toBe(countBefore + 1);
  expect(readConcept(rdb, parent.id)).toEqual(parent);
  rdb.close();
});

test("POST /w/handoff/open opens a pending handoff carrying the named concept", async () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s" });
  const res = await handleViewerRequest(
    writePost("/w/handoff/open", { project: "p", from_surface: "operator", to_surface: "claude-code", concept_ids: c.id, directive: "review please" }),
    rdb,
  );
  expect(res.status).toBe(303);
  const h = rdb.query<{ id: string; status: string; directive: string }, []>("SELECT id, status, directive FROM handoff").get()!;
  expect(h.status).toBe("pending");
  expect(h.directive).toBe("review please");
  expect(rdb.query("SELECT 1 FROM handoff_concept WHERE handoff_id = ? AND concept_id = ?").get(h.id, c.id)).toBeTruthy();
  rdb.close();
});

test("POST /w/handoff/return closes a pending handoff while its snapshot stays frozen", async () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s" });
  const ho = openHandoff(rdb, { project: "p", from_surface: "a", to_surface: "b", concept_ids: [c.id], directive: "go" });
  const res = await handleViewerRequest(writePost("/w/handoff/return", { handoff_id: ho.id, return_note: "done" }), rdb);
  expect(res.status).toBe(303);
  const after = rdb
    .query<{ status: string; return_note: string; payload_snapshot: string }, [string]>(
      "SELECT status, return_note, payload_snapshot FROM handoff WHERE id = ?",
    )
    .get(ho.id)!;
  expect(after.status).toBe("returned");
  expect(after.return_note).toBe("done");
  expect(after.payload_snapshot).toBe(ho.payload_snapshot); // frozen at creation
  rdb.close();
});

test("write forms render only in the live viewer; the static page stays form-free", () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "decision", title: "A", body: "a", surface: "s" });
  openHandoff(rdb, { project: "p", from_surface: "a", to_surface: "b", concept_ids: [c.id], directive: "go" });
  const live = renderHtml(rdb, { live: true });
  const stat = renderHtml(rdb);
  for (const action of ["/w/fork", "/w/comment", "/w/handoff/open", "/w/handoff/return"]) {
    expect(live).toContain(`action="${action}"`);
  }
  expect(stat).not.toContain('method="post"');
  expect(stat).not.toContain('action="/w/');
  rdb.close();
});

test("a malformed write POST is rejected (4xx) and writes nothing", async () => {
  const rdb = initDb(":memory:");
  const res = await handleViewerRequest(writePost("/w/fork", { parent_id: "does-not-exist", body: "x" }), rdb);
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM concept").get()!.n).toBe(0);
  rdb.close();
});

test("an unknown POST path is a 404, not a write", async () => {
  const rdb = initDb(":memory:");
  const res = await handleViewerRequest(writePost("/w/nope", { x: "1" }), rdb);
  expect(res.status).toBe(404);
  rdb.close();
});

test("POST /w/handoff/open with an empty concept_ids is rejected (4xx) and opens no handoff", async () => {
  const rdb = initDb(":memory:");
  const res = await handleViewerRequest(
    writePost("/w/handoff/open", { project: "p", from_surface: "operator", to_surface: "b", concept_ids: "", directive: "go" }),
    rdb,
  );
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoff").get()!.n).toBe(0);
  rdb.close();
});

test("openHandoff itself refuses an empty concept set (the source-level invariant)", () => {
  const rdb = initDb(":memory:");
  expect(() => openHandoff(rdb, { project: "p", from_surface: "a", to_surface: "b", concept_ids: [], directive: "x" })).toThrow(
    /at least one concept/,
  );
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoff").get()!.n).toBe(0);
  rdb.close();
});

test("a handoff opened from the viewer is always attributed to the operator surface, never a submitted value", async () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s" });
  // A forged from_surface in the POST body must be ignored — the origin is hardcoded to the operator.
  const res = await handleViewerRequest(
    writePost("/w/handoff/open", { project: "p", from_surface: "claude-code-impersonator", to_surface: "b", concept_ids: c.id, directive: "go" }),
    rdb,
  );
  expect(res.status).toBe(303);
  const h = rdb.query<{ from_surface_id: string }, []>("SELECT from_surface_id FROM handoff").get()!;
  expect(h.from_surface_id).toBe("operator");
  rdb.close();
});

test("a cross-site write POST is blocked (403) and writes nothing; same-origin/header-less posts pass", async () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Root", body: "root", surface: "s" });
  // A drive-by cross-site form post (browser stamps Sec-Fetch-Site: cross-site) is refused.
  const blocked = await handleViewerRequest(
    writePost("/w/comment", { parent_id: parent.id, body: "evil" }, { "sec-fetch-site": "cross-site" }),
    rdb,
  );
  expect(blocked.status).toBe(403);
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lineage").get()!.n).toBe(0);
  // A same-origin post (the legitimate form) still goes through.
  const ok = await handleViewerRequest(
    writePost("/w/comment", { parent_id: parent.id, body: "kind" }, { "sec-fetch-site": "same-origin" }),
    rdb,
  );
  expect(ok.status).toBe(303);
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lineage").get()!.n).toBe(1);
  rdb.close();
});

test("the live viewer binds to loopback (127.0.0.1), not all interfaces", () => {
  const prev = process.env.HEADWATER_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "headwater-bind-"));
  process.env.HEADWATER_DATA_DIR = dir;
  const server = startViewer(0); // ephemeral port
  try {
    expect(server.hostname).toBe("127.0.0.1");
  } finally {
    server.stop(true);
    if (prev === undefined) delete process.env.HEADWATER_DATA_DIR;
    else process.env.HEADWATER_DATA_DIR = prev;
    // startViewer owns its pool handle in a closure (no external close), so on Windows the WAL files
    // can still be locked here. The assertion is what matters; let the OS reclaim the temp dir.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test("the server ships permanent usage instructions every client gets on connect", () => {
  // Broadcast via the MCP `instructions` field — no per-session/per-project setup on any surface.
  expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
  expect(SERVER_INSTRUCTIONS).toContain("read_project_state"); // the kickoff ritual
  expect(SERVER_INSTRUCTIONS).toContain("fork_concept"); // the immutability/forking rule
  expect(SERVER_INSTRUCTIONS).toContain("How to use headwater effectively"); // pointer to the in-pool guide
});

// --- Engine-enforced invariants: the SQLite substrate itself rejects tampering, not just the tools ---
// The headline claim ("concepts immutable, lineage append-only, handoffs frozen") is enforced by
// BEFORE UPDATE/DELETE triggers, so a raw `sqlite3 pool.db "UPDATE ..."` is rejected too.

test("the engine rejects a concept UPDATE — immutability is enforced at the substrate", () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s" });
  expect(() => rdb.query("UPDATE concept SET body = 'tampered' WHERE id = ?").run(c.id)).toThrow();
  expect(readConcept(rdb, c.id).body).toBe("x"); // unchanged
  rdb.close();
});

test("the engine rejects a concept DELETE", () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s" });
  expect(() => rdb.query("DELETE FROM concept WHERE id = ?").run(c.id)).toThrow();
  expect(readConcept(rdb, c.id)).toBeTruthy();
  rdb.close();
});

test("the engine rejects UPDATE and DELETE on lineage — append-only at the substrate", () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "note", title: "P", body: "p", surface: "s" });
  forkConcept(rdb, { parent_id: parent.id, body: "c", surface: "s" });
  expect(() => rdb.query("UPDATE lineage SET kind = 'supersedes'").run()).toThrow();
  expect(() => rdb.query("DELETE FROM lineage").run()).toThrow();
  rdb.close();
});

test("the engine freezes a handoff's directive/payload/initiated_at but allows the return transition", () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s" });
  const h = openHandoff(rdb, { project: "p", from_surface: "a", to_surface: "b", concept_ids: [c.id], directive: "go" });
  expect(() => rdb.query("UPDATE handoff SET directive = 'changed' WHERE id = ?").run(h.id)).toThrow();
  expect(() => rdb.query("UPDATE handoff SET payload_snapshot = '[]' WHERE id = ?").run(h.id)).toThrow();
  expect(() => rdb.query("UPDATE handoff SET initiated_at = '2000-01-01' WHERE id = ?").run(h.id)).toThrow();
  expect(() => rdb.query("DELETE FROM handoff WHERE id = ?").run(h.id)).toThrow();
  // the legitimate pending -> returned transition (status/returned_at/return_note) still works
  const r = returnHandoff(rdb, { handoff_id: h.id, return_note: "done" });
  expect(r.status).toBe("returned");
  expect(r.return_note).toBe("done");
  rdb.close();
});

// --- DNS-rebinding defense: the viewer only answers loopback Hosts -----------------------------------
// Sec-Fetch-Site blocks classic cross-site CSRF, but a rebound page is *same-origin*; the Host header
// still reads the attacker's domain, so a Host allowlist is the real fix (on reads and writes).

test("the viewer rejects a non-loopback Host (DNS-rebinding defense), on both writes and reads", async () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "decision", title: "A", body: "a", surface: "s" });
  // A rebound page is same-origin to itself (Sec-Fetch-Site passes) but its Host is the attacker's domain.
  const post = new Request("http://evil.example/w/comment", {
    method: "POST",
    body: new URLSearchParams({ parent_id: c.id, body: "x" }),
    headers: { "sec-fetch-site": "same-origin" },
  });
  expect((await handleViewerRequest(post, rdb)).status).toBe(403);
  expect(rdb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lineage").get()!.n).toBe(0);
  // A GET with a foreign Host is also refused (no read-exfiltration via rebinding).
  expect((await handleViewerRequest(new Request("http://evil.example/"), rdb)).status).toBe(403);
  rdb.close();
});

test("the viewer answers loopback Hosts (127.0.0.1 / localhost / [::1], any port)", async () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "A", body: "a", surface: "s" });
  for (const origin of ["http://127.0.0.1:8765/", "http://localhost:8765/", "http://127.0.0.1/", "http://[::1]:8765/"]) {
    expect((await handleViewerRequest(new Request(origin), rdb)).status).toBe(200);
  }
  rdb.close();
});

test("HEADWATER_DATA_DIR overrides the default pool directory (consistent product prefix)", () => {
  const prev = process.env.HEADWATER_DATA_DIR;
  const probe = join(tmpdir(), "headwater-env-probe");
  process.env.HEADWATER_DATA_DIR = probe;
  expect(resolveDataDir()).toBe(probe);
  if (prev === undefined) delete process.env.HEADWATER_DATA_DIR;
  else process.env.HEADWATER_DATA_DIR = prev;
});
