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
import { renderHtml } from "../src/render.ts";

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
