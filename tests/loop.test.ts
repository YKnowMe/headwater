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

// --- the date window + sort order -----------------------------------------------------------------
// Concept cards default to NEWEST-first (the fold then hides old settled work, not recent work), with
// ?sort=oldest to flip. The date window is ONE concept with two mutually exclusive expressions: a
// relative preset (?since=7d) or an absolute inclusive range (?from=&?to=). It scopes concepts only —
// the lineage tree and handoff spine always render whole, exactly like the other four facets.

/** Seed concepts with explicit created_at values (writeConcept always stamps "now"). */
function seedDated(rdb: Database, rows: Array<[title: string, createdAt: string]>): void {
  writeConcept(rdb, { project: "p", type: "note", title: "ANCHOR", body: "a", surface: "s" }); // upserts project + surface
  for (const [title, at] of rows) {
    rdb.run(
      `INSERT INTO concept (id, project_id, type, title, status, body, origin_surface_id, created_at)
       VALUES (?, 'p', 'note', ?, 'active', 'b', 's', ?)`,
      [title.toLowerCase(), title, at],
    );
  }
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

test("concept cards are newest-first by default; ?sort=oldest flips them", () => {
  const rdb = initDb(":memory:");
  seedDated(rdb, [["OLDEST_CARD", "2024-01-01T00:00:00.000Z"], ["NEWER_CARD", "2026-01-01T00:00:00.000Z"]]);

  const def = renderHtml(rdb);
  expect(def.indexOf("NEWER_CARD")).toBeLessThan(def.indexOf("OLDEST_CARD")); // newest-first is the default

  const flipped = renderHtml(rdb, { live: true, sort: "oldest" });
  expect(flipped.indexOf("OLDEST_CARD")).toBeLessThan(flipped.indexOf("NEWER_CARD"));

  rdb.close();
});

test("?since= narrows concepts to a relative window (cutoff computed at render time)", () => {
  const rdb = initDb(":memory:");
  seedDated(rdb, [["INSIDE_WINDOW", daysAgo(3)], ["OUTSIDE_WINDOW", daysAgo(60)]]);

  const html = renderHtml(rdb, { live: true, filters: { since: "7d" } });
  expect(html).toContain("INSIDE_WINDOW");
  expect(html).not.toContain("OUTSIDE_WINDOW");

  rdb.close();
});

test("?from=/?to= narrow concepts to an absolute window, inclusive on both ends", () => {
  const rdb = initDb(":memory:");
  seedDated(rdb, [
    ["BEFORE_RANGE", "2026-06-30T23:59:59.000Z"],
    ["ON_FROM_EDGE", "2026-07-01T00:00:00.000Z"],
    ["INSIDE_RANGE", "2026-07-05T12:00:00.000Z"],
    ["ON_TO_EDGE", "2026-07-10T23:59:59.000Z"], // same UTC day as `to` => included
    ["AFTER_RANGE", "2026-07-11T00:00:00.000Z"],
  ]);

  const html = renderHtml(rdb, { live: true, filters: { from: "2026-07-01", to: "2026-07-10" } });
  expect(html).toContain("ON_FROM_EDGE");
  expect(html).toContain("INSIDE_RANGE");
  expect(html).toContain("ON_TO_EDGE");
  expect(html).not.toContain("BEFORE_RANGE");
  expect(html).not.toContain("AFTER_RANGE");

  rdb.close();
});

test("the window has one expression: a `since` preset supersedes an absolute range", () => {
  const rdb = initDb(":memory:");
  seedDated(rdb, [["RECENT_ONE", daysAgo(2)], ["ANCIENT_ONE", "2024-01-01T00:00:00.000Z"]]);

  // An ambiguous URL can still be hand-typed; `since` wins so the page is never a mystery.
  const html = renderHtml(rdb, { live: true, filters: { since: "7d", from: "2024-01-01", to: "2024-12-31" } });
  expect(html).toContain("RECENT_ONE");
  expect(html).not.toContain("ANCIENT_ONE");

  rdb.close();
});

test("the date window scopes concepts only — the handoff spine still renders whole", async () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "CARRIED", body: "c", surface: "s" });
  openHandoff(rdb, {
    project: "p",
    from_surface: "a",
    to_surface: "b",
    concept_ids: [c.id],
    directive: "SPINE_DIRECTIVE_MARKER",
  });

  // A window that excludes every concept must not empty the timeline.
  const html = renderHtml(rdb, { live: true, filters: { from: "2020-01-01", to: "2020-12-31" } });
  expect(html).not.toContain(">CARRIED<");
  expect(html).toContain("SPINE_DIRECTIVE_MARKER");

  rdb.close();
});

test("handleViewerRequest validates since/from/to/sort and ignores junk values", async () => {
  const rdb = initDb(":memory:");
  seedDated(rdb, [["OLD_JUNK_TEST", "2024-01-01T00:00:00.000Z"], ["NEW_JUNK_TEST", "2026-01-01T00:00:00.000Z"]]);

  const get = async (qs: string) =>
    await (await handleViewerRequest(new Request(`http://localhost/?${qs}`), rdb)).text();

  // Junk is dropped, never bound: an unknown preset / malformed date / bogus sort => the default view.
  const junk = await get("since=all-of-time&from=yesterday&to=DROP+TABLE&sort=sideways");
  expect(junk).toContain("OLD_JUNK_TEST");
  expect(junk).toContain("NEW_JUNK_TEST");
  expect(junk.indexOf("NEW_JUNK_TEST")).toBeLessThan(junk.indexOf("OLD_JUNK_TEST")); // default sort held

  // Valid params are honored end to end.
  const scoped = await get("from=2025-01-01&to=2027-01-01");
  expect(scoped).toContain("NEW_JUNK_TEST");
  expect(scoped).not.toContain("OLD_JUNK_TEST");

  rdb.close();
});

test("date + sort controls render live-only; the static file stays form-free", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "A", body: "a", surface: "s" });

  const live = renderHtml(rdb, { live: true });
  const stat = renderHtml(rdb);

  expect(live).toContain('name="from"');
  expect(live).toContain('name="to"');
  expect(live).toContain("since=7d");
  expect(live).toContain("sort=oldest");
  expect(stat).not.toContain('name="from"');
  expect(stat).not.toContain("since=7d");
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

// --- render.ts: concept-body content types (lists, checklists, wikilinks) — the settled Design pass.
// Task registries are ordinary concepts kept current by supersede-forks (no new entity); the ONLY new
// machinery is presentation: checklist markdown -> styled checkboxes, list markdown -> real lists, and
// [[wikilinks]] resolved against the pool (link) or not (ghost). Same escape-first rules as the rest.

test("rich body renders bulleted and numbered list runs as real lists", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, {
    project: "p", type: "note", title: "lists", surface: "s",
    body: "1. first step\n2. second step\n- alpha\n- beta",
  });
  const html = renderHtml(rdb);
  expect(html).toContain("<ol><li>first step</li><li>second step</li></ol>");
  expect(html).toContain("<ul><li>alpha</li><li>beta</li></ul>");
  rdb.close();
});

test("checklist markdown renders as a task list; done items are marked, text preserved", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, {
    project: "p", type: "note", title: "registry", surface: "s",
    body: "- [x] shipped thing\n- [ ] open thing",
  });
  const html = renderHtml(rdb);
  expect(html).toContain('<ul class="tasks">');
  expect(html).toContain('<li class="done"><span class="task-text">shipped thing</span></li>');
  expect(html).toContain('<li><span class="task-text">open thing</span></li>');
  rdb.close();
});

test("task and list items get inline formatting and stay injection-safe", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, {
    project: "p", type: "note", title: "safe", surface: "s",
    body: "- [x] closed by `abc-123`\n- [ ] <script>alert(1)</script>",
  });
  const html = renderHtml(rdb);
  expect(html).toContain('<span class="task-text">closed by <code>abc-123</code></span>');
  expect(html).not.toContain("<script>alert(1)");
  expect(html).toContain('<span class="task-text">&lt;script&gt;alert(1)&lt;/script&gt;</span>');
  rdb.close();
});

test("a wikilink to a concept id in the pool links to that concept's anchored card", () => {
  const rdb = initDb(":memory:");
  const target = writeConcept(rdb, { project: "p", type: "decision", title: "Adopt Bun", body: "t", surface: "s" });
  writeConcept(rdb, { project: "p", type: "note", title: "ref", body: `see [[${target.id}]] for context`, surface: "s" });
  const html = renderHtml(rdb);
  expect(html).toContain(`<a class="wl" href="#${target.id}">[[${target.id}]]</a>`);
  expect(html).toContain(`id="${target.id}"`); // the card carries the anchor the link points at
  rdb.close();
});

test("a wikilink written without the id's hash suffix still resolves (prefix match)", () => {
  const rdb = initDb(":memory:");
  const target = writeConcept(rdb, { project: "p", type: "decision", title: "Adopt Bun", body: "t", surface: "s" });
  const prefix = target.id.slice(0, target.id.lastIndexOf("-")); // e.g. "adopt-bun"
  writeConcept(rdb, { project: "p", type: "note", title: "ref", body: `see [[${prefix}]]`, surface: "s" });
  const html = renderHtml(rdb);
  expect(html).toContain(`<a class="wl" href="#${target.id}">[[${prefix}]]</a>`);
  rdb.close();
});

test("a dangling wikilink renders as a ghost (dashed, tooltip), never a link", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "note", title: "ref", body: "see [[fts-introduction-plan]]", surface: "s" });
  const html = renderHtml(rdb);
  expect(html).toContain(
    '<span class="wl-ghost" title="referenced concept id not present in the pool">[[fts-introduction-plan]]</span>',
  );
  expect(html).not.toContain('href="#fts-introduction-plan"');
  expect(html).toMatch(/\.wl-ghost[^}]*dashed/); // the ghost grammar: dashed = expected-but-not-present
  rdb.close();
});

test("a wikilink naming a handoff id resolves to the handoff's anchored entry", () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "X", body: "x", surface: "s1" });
  const h = openHandoff(rdb, { project: "p", from_surface: "s1", to_surface: "s2", concept_ids: [c.id], directive: "go" });
  writeConcept(rdb, { project: "p", type: "note", title: "ref", body: `loop: [[${h.id}]]`, surface: "s1" });
  const html = renderHtml(rdb);
  expect(html).toContain(`<a class="wl" href="#${h.id}">[[${h.id}]]</a>`);
  expect(html).toContain(`id="${h.id}"`);
  rdb.close();
});

// --- Derived closure: lineage closes a concept; status is never mutated (decision 0cc10bf3) ---------
// Concepts reject every UPDATE, so `resolved` is unreachable as a stored transition. Closure is
// DERIVED: a supersedes child closes any concept; a decision child (forks_from/evolved_from/
// supersedes) closes an open_question. annotates/relates_to/depends_on never close. Presentation
// only — the stored row keeps its status; kickoff + viewer re-bucket by effective status.

test("an answered open_question presents as resolved, carrying closed_by -> the answering fork", () => {
  const rdb = initDb(":memory:");
  const q = writeConcept(rdb, { project: "p", type: "open_question", title: "Which db?", body: "?", surface: "s" });
  const a = forkConcept(rdb, { parent_id: q.id, body: "sqlite, because local-first", surface: "s", type: "decision", title: "Use sqlite" });
  const state = readProjectState(rdb, "p");
  const resolvedIds = state.concepts_by_status.resolved.map((c) => c.id);
  expect(resolvedIds).toContain(q.id);
  expect(state.concepts_by_status.active.map((c) => c.id)).not.toContain(q.id);
  const closed = state.concepts_by_status.resolved.find((c) => c.id === q.id)!;
  expect(closed.closed_by).toEqual({ concept_id: a.id, via: "decision" });
  expect(closed.status).toBe("active"); // the stored row is untouched — the derivation stays visible
  rdb.close();
});

test("a supersedes fork closes any concept type; the earliest closing fork wins", () => {
  const rdb = initDb(":memory:");
  const c = writeConcept(rdb, { project: "p", type: "note", title: "Old registry", body: "rev 1", surface: "s" });
  const rev2 = forkConcept(rdb, { parent_id: c.id, body: "rev 2", surface: "s", kind: "supersedes" });
  forkConcept(rdb, { parent_id: c.id, body: "rev 3 (also supersedes, later)", surface: "s", kind: "supersedes" });
  const state = readProjectState(rdb, "p");
  const closed = state.concepts_by_status.resolved.find((x) => x.id === c.id)!;
  expect(closed.closed_by).toEqual({ concept_id: rev2.id, via: "supersedes" });
  rdb.close();
});

test("comments and soft edges never close: annotates on anything, decision via relates_to", () => {
  const rdb = initDb(":memory:");
  const q = writeConcept(rdb, { project: "p", type: "open_question", title: "Open?", body: "?", surface: "s" });
  forkConcept(rdb, { parent_id: q.id, body: "just a comment", surface: "s", kind: "annotates", type: "decision" });
  forkConcept(rdb, { parent_id: q.id, body: "related decision", surface: "s", kind: "relates_to", type: "decision" });
  const n = writeConcept(rdb, { project: "p", type: "note", title: "Note", body: "n", surface: "s" });
  forkConcept(rdb, { parent_id: n.id, body: "a mere fork", surface: "s", kind: "forks_from", type: "decision" });
  const state = readProjectState(rdb, "p");
  const activeIds = state.concepts_by_status.active.map((c) => c.id);
  expect(activeIds).toContain(q.id); // open_question stays open
  expect(activeIds).toContain(n.id); // a note is not answerable — only supersedes closes it
  expect(state.concepts_by_status.resolved).toHaveLength(0);
  rdb.close();
});

test("the viewer groups a derived-closed concept under resolved and badges the closing fork", () => {
  const rdb = initDb(":memory:");
  const q = writeConcept(rdb, { project: "p", type: "open_question", title: "VIEWER_QUESTION", body: "?", surface: "s" });
  const a = forkConcept(rdb, { parent_id: q.id, body: "answer", surface: "s", type: "decision", title: "VIEWER_ANSWER" });
  const html = renderHtml(rdb);
  // the question's card sits inside the resolved status group, not active
  const resolvedGroup = html.slice(html.indexOf("st-resolved"));
  expect(resolvedGroup).toContain("VIEWER_QUESTION");
  // and carries a closed-by annotation linking to the closing fork
  expect(html).toMatch(new RegExp(`class="closed-by">resolved by <a class="wl" href="#${a.id}"`));
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

test("lineage renders ONE canonical tree — the SVG diagram and adjacency table are pruned", () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Parent", body: "p", surface: "s" });
  forkConcept(rdb, { parent_id: parent.id, body: "child body", surface: "s", title: "Child", reason: "inference" });
  const html = renderHtml(rdb);
  expect(html).toContain('<div class="tree">');
  // a fork edge's whole evidence (kind + reason badges) fits inline on the branch row — no reveal needed
  expect(html).toMatch(/class="branch"[\s\S]*?badge edge[\s\S]*?badge reason/);
  expect(html).not.toContain('lineage-svg');
  expect(html).not.toContain('class="ltbl"');
  rdb.close();
});

test("handoffs render ONE canonical spine timeline — cards/table/SVG variants are pruned", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "A", body: "a", surface: "s1" });
  openHandoff(rdb, { project: "p", from_surface: "s1", to_surface: "s2", concept_ids: [a.id], directive: "do x" });
  const html = renderHtml(rdb);
  expect(html).toContain('<ul class="timeline">');
  expect(html).toContain('class="ho is-pending"');
  expect(html).not.toContain('class="htbl"');
  expect(html).not.toContain('timeline-svg');
  rdb.close();
});

test("render adds a type x status matrix per project", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "p", type: "decision", title: "A", body: "a", surface: "s", status: "active" });
  const html = renderHtml(rdb);
  expect(html).toContain('<table class="matrix">');
  rdb.close();
});

test("the lineage/handoff representation switches are gone — one tree, one timeline", () => {
  const rdb = initDb(":memory:");
  const parent = writeConcept(rdb, { project: "p", type: "decision", title: "Parent", body: "p", surface: "s" });
  forkConcept(rdb, { parent_id: parent.id, body: "c", surface: "s", title: "Child" });
  openHandoff(rdb, { project: "p", from_surface: "s1", to_surface: "s2", concept_ids: [parent.id], directive: "do x" });
  const html = renderHtml(rdb);
  expect(html).not.toMatch(/<details class="view" name="lin-/);
  expect(html).not.toMatch(/<details class="view" name="ho-/);
  rdb.close();
});

// --- render.ts: the settled timeline/lineage pass (handoff-0a0b4ed8) ------------------------------
// Decisions: (1) inline-expand evidence via ONE native <details>; (2) frozen vs current side-by-side
// panes + a drift verdict; (3) one vertical spine timeline; (4) the ghost grammar — dashed/italic/
// hollow = expected-but-not-present — for open loops and dangling wikilinks.

test("a returned handoff shows route, badge, evidence with its return note, and a returned terminus", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "Carried", body: "cargo", surface: "alpha" });
  const h = openHandoff(rdb, { project: "p", from_surface: "alpha", to_surface: "beta", concept_ids: [a.id], directive: "go" });
  returnHandoff(rdb, { handoff_id: h.id, return_note: "came back with results" });
  const html = renderHtml(rdb);
  expect(html).toContain('class="ho is-returned"');
  expect(html).toMatch(/class="route">alpha <span class="arrow">&rarr;<\/span> beta/);
  expect(html).toContain('<details class="evidence">');
  expect(html).toMatch(/class="return-note"[\s\S]*?came back with results/);
  expect(html).toMatch(/class="terminus ret"><span class="who">beta<\/span> returned/);
  rdb.close();
});

test("a pending handoff is the open-loop shape: dashed spine class, open evidence, no-return placeholder, ghost terminus", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "Carried", body: "cargo", surface: "alpha" });
  openHandoff(rdb, { project: "p", from_surface: "alpha", to_surface: "beta", concept_ids: [a.id], directive: "go" });
  const html = renderHtml(rdb);
  expect(html).toContain('class="ho is-pending"');
  expect(html).toContain('<details class="evidence" open>'); // the open loop's evidence starts revealed
  expect(html).toContain('<div class="no-return">no return note yet — the loop is open</div>');
  expect(html).toMatch(/class="terminus ghost"><span class="who">beta<\/span> has not written back — awaiting return/);
  rdb.close();
});

test("evidence shows frozen and current panes per carried concept; untouched concepts read 'unchanged'", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "Carried", body: "the frozen cargo body", surface: "alpha" });
  openHandoff(rdb, { project: "p", from_surface: "alpha", to_surface: "beta", concept_ids: [a.id], directive: "go" });
  const html = renderHtml(rdb);
  expect(html).toContain("frozen — as handed off");
  expect(html).toContain("current — in pool now");
  // both panes carry the body (immutable + unforked -> identical), and the verdict is green/unchanged
  expect(html.split("the frozen cargo body").length).toBeGreaterThanOrEqual(3);
  expect(html).toContain('<span class="drift same">unchanged since handoff</span>');
  rdb.close();
});

test("a concept forked after the handoff reads as drift, naming the fork id", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "Carried", body: "cargo", surface: "alpha" });
  openHandoff(rdb, { project: "p", from_surface: "alpha", to_surface: "beta", concept_ids: [a.id], directive: "go" });
  const f = forkConcept(rdb, { parent_id: a.id, body: "moved on", surface: "beta" });
  const html = renderHtml(rdb);
  expect(html).toMatch(new RegExp(`class="drift moved">diverged — 1 fork since handoff: <code class="id">${f.id}</code>`));
  rdb.close();
});

test("a pending handoff gives its carried concept a tree: the handoff edge + the expected-return ghost branch", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "Carried", body: "cargo", surface: "alpha" });
  const h = openHandoff(rdb, { project: "p", from_surface: "alpha", to_surface: "beta", concept_ids: [a.id], directive: "go" });
  const html = renderHtml(rdb);
  expect(html).toMatch(/class="branch ho-edge"[\s\S]*?handoff · pending[\s\S]*?carried by/);
  expect(html).toContain(`<code class="id">${h.id}</code>`);
  expect(html).toMatch(/class="branch ghost-branch"[\s\S]*?expected[\s\S]*?return concept from <code>beta<\/code> — not yet in pool/);
  rdb.close();
});

test("a tree root whose body cites a missing concept grows a dangling-link ghost branch", () => {
  const rdb = initDb(":memory:");
  const root = writeConcept(rdb, {
    project: "p", type: "note", title: "Root", surface: "s",
    body: "see [[missing-spec]] and [[also-missing]]",
  });
  forkConcept(rdb, { parent_id: root.id, body: "child", surface: "s", title: "Child" });
  const html = renderHtml(rdb);
  expect(html).toMatch(/class="branch ghost-branch"[\s\S]*?dangling link[\s\S]*?\[\[missing-spec\]\]<\/code> — no such concept in the pool/);
  expect(html).toMatch(/\[\[also-missing\]\]<\/code> — no such concept in the pool/);
  rdb.close();
});

test("wikilinks inside a handoff directive resolve like concept bodies (link or ghost)", () => {
  const rdb = initDb(":memory:");
  const a = writeConcept(rdb, { project: "p", type: "note", title: "Target", body: "t", surface: "s" });
  openHandoff(rdb, {
    project: "p", from_surface: "s", to_surface: "s2", concept_ids: [a.id],
    directive: `read [[${a.id}]] and [[nowhere-to-be-found]]`,
  });
  const html = renderHtml(rdb);
  expect(html).toContain(`<a class="wl" href="#${a.id}">[[${a.id}]]</a>`);
  expect(html).toContain('<span class="wl-ghost" title="referenced concept id not present in the pool">[[nowhere-to-be-found]]</span>');
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
  expect(SERVER_INSTRUCTIONS).toContain("[[concept-id]]"); // the cite-by-id convention feeds link/ghost rendering
  expect(SERVER_INSTRUCTIONS).toContain("read_concept"); // kickoff bodies are previews; this is full recall
});

// --- read_project_state stays context-sized: bodies are previews, read_concept is full recall ------
// Observed failure: a mature pool's kickoff result blew past a client's context budget because every
// concept (and every frozen snapshot concept) carried its full body. The kickoff is a MAP of the
// project, not the archive — bodies arrive as bounded previews and read_concept(id) recalls the rest.

test("read_project_state previews long bodies instead of shipping them whole", () => {
  const rdb = initDb(":memory:");
  const long = "start-marker " + "x".repeat(2000) + " end-marker";
  const c = writeConcept(rdb, { project: "big", type: "note", title: "LONG", body: long, surface: "s" });
  const state = readProjectState(rdb, "big");
  const inState = state.concepts_by_status.active[0]!;
  expect(inState.body_preview.length).toBeLessThanOrEqual(281); // bounded (280 + ellipsis char)
  expect(inState.body_preview).toContain("start-marker");
  expect(inState.body_preview.endsWith("…")).toBe(true);
  expect("body" in inState).toBe(false); // no full body riding along
  expect(JSON.stringify(state)).not.toContain("end-marker");
  // full recall stays first-class
  expect(readConcept(rdb, c.id).body).toBe(long);
  rdb.close();
});

test("read_project_state previews the frozen snapshot bodies inside handoffs too; directives stay whole", () => {
  const rdb = initDb(":memory:");
  const long = "cargo-head " + "y".repeat(2000) + " cargo-tail";
  const c = writeConcept(rdb, { project: "big", type: "note", title: "CARGO", body: long, surface: "s" });
  openHandoff(rdb, { project: "big", from_surface: "a", to_surface: "b", concept_ids: [c.id], directive: "do the thing" });
  const state = readProjectState(rdb, "big");
  const ho = state.open_handoffs[0]! as { directive: string; payload_snapshot: Array<{ body_preview: string }> };
  expect(ho.directive).toBe("do the thing");
  expect(ho.payload_snapshot[0]!.body_preview).toContain("cargo-head");
  expect(JSON.stringify(ho)).not.toContain("cargo-tail");
  rdb.close();
});

test("short bodies survive a kickoff preview verbatim (minus nothing)", () => {
  const rdb = initDb(":memory:");
  writeConcept(rdb, { project: "big", type: "note", title: "SHORT", body: "small body", surface: "s" });
  const state = readProjectState(rdb, "big");
  expect(state.concepts_by_status.active[0]!.body_preview).toBe("small body");
  // recents are heads: identity only — the summary above is the single copy of the preview
  expect(state.recent_concepts[0]!.title).toBe("SHORT");
  expect("body_preview" in state.recent_concepts[0]!).toBe(false);
  rdb.close();
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
