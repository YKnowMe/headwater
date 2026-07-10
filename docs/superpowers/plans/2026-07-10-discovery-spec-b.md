# Discovery (Spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `read_handoff(id)` and `find_concepts(project, query, limit)`, and give `read_project_state` a `mode: full|lean|ids` parameter (default `lean`) — per `docs/superpowers/specs/2026-07-10-discovery-spec-b-design.md` (commit `5f5611f`).

**Architecture:** Everything rides the Spec A `callTool` dispatcher (logging + error discipline for free). Two new tool functions (`readHandoff`, `findConcepts`) mirror `readConcept`'s throw-on-unknown style. Mode shaping is two pure exported functions (`leanProjectState`, `idsProjectState`) over the unchanged `readProjectState` output; the dispatcher picks shape and serialization (compact for lean/ids, pretty for full — full stays byte-identical to today). `SERVER_INSTRUCTIONS` and the docs teach the new grammar.

**Tech Stack:** TypeScript on Bun; `bun:sqlite`; `bun:test`. No new deps, no new files.

## Global Constraints

- Tool surface grows six → eight — **operator-ratified fence amendment**, must be recorded in CLAUDE.md.
- `find_concepts` is plain SQL `LIKE` with `ESCAPE '\'` — **no FTS** (the fence stands).
- `mode` default is **`lean`**. `full` output must be **byte-identical** to `JSON.stringify(readProjectState(db, project), null, 2)` (readProjectState is untouched — that equality IS the back-compat guarantee).
- `lean`/`ids` serialize **compact** (`JSON.stringify(x)`, no indent); `full` stays pretty (`null, 2`).
- Durable types (keep previews in lean): `decision`, `architecture`, `constraint`, `open_question`. Heads for `note`/`feature` and for resolved/discarded.
- Head shape: `{id, type, title, status, created_at, closed_by?}` — the existing `ConceptHead`.
- Handoff/recents sections: Spec A shapes in every mode, untouched.
- The 128 KB degrade guard applies to all modes, unchanged.
- Existing six tools' signatures untouched; `mode` and the two tools are additive.
- Logs to `<data dir>/headwater.log` via the existing `logCall` — no new logging code.
- Windows test discipline: `db.close()` before temp-dir deletion. Never touch the live pool.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server.ts` | **Modify.** `readHandoff`, `findConcepts`, `leanProjectState`, `idsProjectState`; `callTool` cases; two `registerTool` blocks; `SERVER_INSTRUCTIONS` rewrite. |
| `tests/reliability.test.ts` | **Modify.** New coverage (Tasks 1-2). |
| `CLAUDE.md`, `README.md` | **Modify** (Task 3). Six → eight + mode docs. |

---

### Task 1: `read_handoff` + `find_concepts`

**Files:**
- Modify: `src/server.ts` (functions near `readConcept` ~line 238; `callTool` cases; `registerTool` blocks at the end of `registerTools`)
- Test: `tests/reliability.test.ts`

**Interfaces:**
- Consumes: `getHandoff`, `presentHandoff`, `summarize`, `computeClosures`, `slugify`, `callTool`, `ok`/`fail` — all existing in `src/server.ts`.
- Produces:
  - `readHandoff(db: Database, id: string): Record<string, unknown>` — `presentHandoff(row)`; throws `unknown handoff: <id>`.
  - `findConcepts(db: Database, args: { project: string; query: string; limit?: number }): ConceptSummary[]` — throws on empty/whitespace query; limit clamped 1–100 default 20; newest first; `closed_by` attached.

- [ ] **Step 1: Write the failing tests**

Append to `tests/reliability.test.ts`; extend the `../src/server.ts` import with `readHandoff, findConcepts, forkConcept` (forkConcept for the closed_by test):

```ts
// --- Spec B: discovery — read_handoff + find_concepts ----------------------------------------

test("read_handoff recalls the full frozen snapshot — bodies whole, directive whole", () => {
  const long = "frozen-head " + "f".repeat(2000) + " frozen-tail";
  const c = writeConcept(db, { project: "rel-test", type: "note", title: "cargo", body: long, surface: "test:rel" });
  const h = openHandoff(db, {
    project: "rel-test", from_surface: "test:a", to_surface: "test:b",
    concept_ids: [c.id], directive: "act on the whole thing",
  });
  returnHandoff(db, { handoff_id: h.id, return_note: "done in full" });

  const got = readHandoff(db, h.id) as Record<string, unknown>;
  expect(got.id).toBe(h.id);
  expect(got.directive).toBe("act on the whole thing"); // whole, not previewed
  expect(got.return_note).toBe("done in full");
  const snap = got.payload_snapshot as Array<Record<string, unknown>>;
  expect(snap[0]!.body).toBe(long); // FULL frozen body — this IS the recall path
});

test("read_handoff throws on an unknown id", () => {
  expect(() => readHandoff(db, "no-such-handoff")).toThrow(/unknown handoff/);
});

test("read_handoff through callTool answers and logs", () => {
  const h = seedHandoff();
  const res = callTool(db, "read_handoff", { id: h.id });
  expect(res.isError).toBeUndefined();
  expect((JSON.parse(res.content[0]!.text) as { id: string }).id).toBe(h.id);
  const line = readLogLines().at(-1)!;
  expect(line.op).toBe("read_handoff");
  expect(line.project).toBe("rel-test");
});

test("find_concepts matches title and body, newest first, project-scoped", () => {
  writeConcept(db, { project: "rel-test", type: "note", title: "alpha zebra", body: "plain", surface: "s" });
  writeConcept(db, { project: "rel-test", type: "note", title: "beta", body: "the zebra hides here", surface: "s" });
  writeConcept(db, { project: "other-project", type: "note", title: "zebra elsewhere", body: "x", surface: "s" });

  const hits = findConcepts(db, { project: "rel-test", query: "zebra" });
  expect(hits).toHaveLength(2);
  expect(hits[0]!.title).toBe("beta"); // newest first
  expect(hits.every((h) => h.project_id === "rel-test")).toBe(true);
  expect("body_preview" in hits[0]!).toBe(true); // summaries, not full bodies
  expect("body" in hits[0]!).toBe(false);
});

test("find_concepts treats % and _ literally", () => {
  writeConcept(db, { project: "rel-test", type: "note", title: "has 100% coverage", body: "b", surface: "s" });
  writeConcept(db, { project: "rel-test", type: "note", title: "plain title", body: "b", surface: "s" });
  expect(findConcepts(db, { project: "rel-test", query: "100%" })).toHaveLength(1);
  expect(findConcepts(db, { project: "rel-test", query: "%" })).toHaveLength(1); // literal %, not match-all
  expect(findConcepts(db, { project: "rel-test", query: "a_n" })).toHaveLength(0); // _ is literal too
});

test("find_concepts rejects an empty query and clamps limit", () => {
  expect(() => findConcepts(db, { project: "rel-test", query: "   " })).toThrow(/non-empty query/);
  for (let i = 0; i < 5; i++) {
    writeConcept(db, { project: "rel-test", type: "note", title: `bulk ${i}`, body: "same-token", surface: "s" });
  }
  expect(findConcepts(db, { project: "rel-test", query: "same-token", limit: 2 })).toHaveLength(2);
  expect(findConcepts(db, { project: "rel-test", query: "same-token", limit: 0 })).toHaveLength(1); // clamped to 1
  expect(findConcepts(db, { project: "rel-test", query: "same-token", limit: 999 })).toHaveLength(5); // clamp to 100 > 5
});

test("find_concepts carries closed_by on a derived-closed hit", () => {
  const q = writeConcept(db, { project: "rel-test", type: "open_question", title: "findable question", body: "q-token", surface: "s" });
  const d = forkConcept(db, { parent_id: q.id, body: "answered", surface: "s", type: "decision", kind: "forks_from" });
  const hits = findConcepts(db, { project: "rel-test", query: "q-token" });
  const hit = hits.find((h) => h.id === q.id)!;
  expect(hit.closed_by).toEqual({ concept_id: d.id, via: "decision" });
});

test("find_concepts through callTool logs with the project", () => {
  writeConcept(db, { project: "rel-test", type: "note", title: "loggable", body: "b", surface: "s" });
  const res = callTool(db, "find_concepts", { project: "rel-test", query: "loggable" });
  expect(res.isError).toBeUndefined();
  expect(readLogLines().at(-1)!.op).toBe("find_concepts");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/reliability.test.ts` — Expected: FAIL, import error on `readHandoff`/`findConcepts`.

- [ ] **Step 3: Implement**

In `src/server.ts`, directly after `readConcept` (~line 242), add:

```ts
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
```

In `callTool`'s switch, after the `read_concept` case:

```ts
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
```

In `registerTools`, after the `read_concept` block, two new registrations:

```ts
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
```

- [ ] **Step 4: Green + full suite**

Run: `bun test tests/reliability.test.ts` → PASS (8 new). Then `bun test` → all pass (119).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/reliability.test.ts
git commit -m "feat(server): read_handoff + find_concepts — discovery is first-class

Handoff recall no longer lives only inside the state read (the gap behind
the largest coordination outage), and search replaces full-state grepping.
find_concepts is plain LIKE with escaped wildcards — the no-FTS fence
stands. Both ride callTool: logged, error-disciplined. Tool surface six ->
eight per the operator-ratified fence amendment."
```

---

### Task 2: `read_project_state` modes

**Files:**
- Modify: `src/server.ts` (shapers after `degradeProjectState`; the `read_project_state` case in `callTool`; the `read_project_state` `registerTool` inputSchema)
- Test: `tests/reliability.test.ts`

**Interfaces:**
- Consumes: `readProjectState` (UNTOUCHED), `ConceptSummary`, `ConceptHead`, `maxResponseBytes`, `degradeProjectState`, `ok`.
- Produces:
  - `leanProjectState(state: ProjectState): Record<string, unknown>`
  - `idsProjectState(state: ProjectState): Record<string, unknown>`
  - `callTool(db, "read_project_state", { project, mode? })` — `mode?: "full" | "lean" | "ids"`, default `"lean"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/reliability.test.ts`; extend the import with `leanProjectState, idsProjectState`:

```ts
// --- Spec B: state modes — lean default, full byte-identical, ids minimal ---------------------

/** One durable + one chatty concept in each of active and (derived) resolved. */
function seedModes(): void {
  writeConcept(db, { project: "rel-test", type: "decision", title: "durable active", body: "why it was decided ".repeat(30), surface: "s" });
  writeConcept(db, { project: "rel-test", type: "note", title: "chatty active", body: "routine chatter ".repeat(30), surface: "s" });
  const q = writeConcept(db, { project: "rel-test", type: "open_question", title: "old question", body: "asked", surface: "s" });
  forkConcept(db, { parent_id: q.id, body: "settled", surface: "s", type: "decision", kind: "forks_from" });
}

test("default mode is lean: durable types keep previews, notes and the archive become heads", () => {
  seedModes();
  const res = callTool(db, "read_project_state", { project: "rel-test" }); // no mode arg
  expect(res.isError).toBeUndefined();
  expect(res.content[0]!.text.includes('\n  "')).toBe(false); // compact, not pretty
  const st = JSON.parse(res.content[0]!.text) as any;

  const active = st.concepts_by_status.active as Array<Record<string, unknown>>;
  const durable = active.find((c) => c.title === "durable active")!;
  const chatty = active.find((c) => c.title === "chatty active")!;
  expect("body_preview" in durable).toBe(true);
  expect("body_preview" in chatty).toBe(false); // head only
  expect(Object.keys(chatty).sort()).toEqual(["created_at", "id", "status", "title", "type"]);

  const resolved = st.concepts_by_status.resolved as Array<Record<string, unknown>>;
  const closedQ = resolved.find((c) => c.title === "old question")!;
  expect("body_preview" in closedQ).toBe(false);
  expect(closedQ.closed_by).toBeDefined(); // heads keep closure visible
});

test("mode:'full' is byte-identical to the pretty serialization of readProjectState", () => {
  seedModes();
  const res = callTool(db, "read_project_state", { project: "rel-test", mode: "full" });
  expect(res.content[0]!.text).toBe(JSON.stringify(readProjectState(db, "rel-test"), null, 2));
});

test("mode:'ids' is heads everywhere plus per-status counts, compact", () => {
  seedModes();
  const res = callTool(db, "read_project_state", { project: "rel-test", mode: "ids" });
  const st = JSON.parse(res.content[0]!.text) as any;
  // active = durable + chatty + the closing decision fork (a fork is a NEW active concept)
  expect(st.concept_counts.active).toBe(3);
  expect(st.concept_counts.resolved).toBe(1); // the derived-closed open_question
  const all = Object.values(st.concepts_by_status).flat() as Array<Record<string, unknown>>;
  expect(all.every((c) => !("body_preview" in c))).toBe(true);
  expect(res.content[0]!.text.includes('\n  "')).toBe(false);
});

test("the degrade guard still fires in lean mode", () => {
  for (let i = 0; i < 5; i++) {
    writeConcept(db, { project: "rel-test", type: "decision", title: `big ${i}`, body: "z".repeat(500), surface: "s" });
  }
  process.env.HEADWATER_MAX_RESPONSE_BYTES = "1024";
  const res = callTool(db, "read_project_state", { project: "rel-test" });
  expect(res.isError).toBeUndefined();
  expect((JSON.parse(res.content[0]!.text) as any).degraded).toBe(true);
});

test("lean at 10x scale stays under 2s and under the cap", () => {
  seedTenX(db);
  const t0 = performance.now();
  const res = callTool(db, "read_project_state", { project: "scale" });
  const ms = performance.now() - t0;
  expect(res.isError).toBeUndefined();
  expect(ms).toBeLessThan(2_000);
  expect((JSON.parse(res.content[0]!.text) as any).degraded).toBeUndefined();
  console.error(`[scale] lean at 10x: ${Math.round(ms)}ms, ${res.content[0]!.text.length} bytes`);
}, 30_000);
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/reliability.test.ts` — Expected: FAIL, import error on the shapers, then the default-mode test failing (current output is pretty full).

- [ ] **Step 3: Implement**

In `src/server.ts`, after `degradeProjectState`:

```ts
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
```

Replace `callTool`'s `read_project_state` case:

```ts
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
            : JSON.stringify(mode === "lean" ? leanProjectState(state) : idsProjectState(state));
        if (text.length > maxResponseBytes()) {
          degraded = true;
          result = ok(degradeProjectState(state));
        } else {
          result = { content: [{ type: "text", text }] };
        }
        break;
      }
```

In the `read_project_state` `registerTool` block, add to `inputSchema` (after `project`) and extend the description:

```ts
        mode: z
          .enum(["full", "lean", "ids"])
          .default("lean")
          .describe(
            "lean (default): durable-type previews + heads for notes and the archive. " +
              "full: everything with previews (heaviest). ids: heads + counts only.",
          ),
```

and append to the tool `description`: `"Default mode is lean — use find_concepts/read_concept for anything it elides; mode:'full' only when you truly need every preview."`

- [ ] **Step 4: Green + full suite**

Run: `bun test tests/reliability.test.ts` → PASS (13 new across Spec B). `bun test` → all pass (124).
Two existing Spec A tests break under the lean default — fix them exactly as follows, weakening nothing:

1. `"an under-cap state response has no degraded key and ships the full shape"` — its active **note**
   becomes a head under lean, so the `body_preview` assertion fails. Change the seeded concept's
   `type: "note"` to `type: "decision"` (durable types keep previews in lean; the test's intent —
   under-cap responses ship previews — is preserved).
2. `"an oversized state response degrades to ids+titles+counts instead of erroring"` — its 5 seeded
   notes become heads under lean, dropping the response BELOW the forced 1024-byte cap, so it no longer
   degrades. Add `mode: "full"` to that test's `callTool` args (the test is about the guard, which is
   mode-independent; full keeps the payload over the cap). Its `degradeProjectState` shape assertions
   are unchanged.

If any OTHER Spec A assertion trips on the lean default, prefer `mode: "full"` when the test is
genuinely about full-shape behavior — and list every such change in your report.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/reliability.test.ts
git commit -m "feat(server): read_project_state modes — lean default caps kickoff growth

lean (default): previews only for durable types (decision/architecture/
constraint/open_question); heads for note/feature chatter and the archive;
compact JSON. Measured 82.2 -> 55.9 KB on the heaviest live project, and
note traffic stops growing the kickoff. full = byte-identical pretty
output (the back-compat guarantee); ids = heads + counts. The 128 KB
degrade guard backstops every mode."
```

---

### Task 3: Teach the grammar — SERVER_INSTRUCTIONS + docs

**Files:**
- Modify: `src/server.ts` (`SERVER_INSTRUCTIONS`), `CLAUDE.md`, `README.md`

**Interfaces:** consumes the shipped tools; produces no code.

- [ ] **Step 1: Rewrite `SERVER_INSTRUCTIONS`**

Replace the `KICKOFF:` line with:

```
"KICKOFF: before substantive work call read_project_state(<project>) — the default lean mode carries previews for decisions/architecture/constraints/open questions and heads for the rest; read_concept(id) recalls any full text, read_handoff(id) recalls a full handoff (frozen snapshot included). Pin <project> per surface; never infer it from a directory name.",
```

Insert a new line after the KICKOFF entry:

```
"DISCOVER: find_concepts(project, query) substring-searches titles+bodies and returns summaries — search first; request mode:'full' state only when you truly need every preview. mode:'ids' is the minimal map.",
```

Update the HAND OFF line's end from `"The payload snapshot is frozen at creation."` to `"The payload snapshot is frozen at creation; read_handoff(id) recalls it whole. Returning twice is safe: an identical note is a no-op, a different note is refused."`

- [ ] **Step 2: Update CLAUDE.md**

(a) Heading `## The six MCP tools` → `## The eight MCP tools`, and directly under it add:

```markdown
*(Grown from six by a recorded, operator-approved amendment (2026-07-10): `read_handoff` and
`find_concepts` close the discovery gap that caused a live coordination outage. `find_concepts` is
plain SQL `LIKE` — the no-FTS fence below still stands.)*
```

(b) Add two bullets after the `read_project_state` bullet:

```markdown
- `read_handoff(id)` → the handoff row with `directive`, `return_note`, and the frozen
  `payload_snapshot` **whole** (full concept bodies). The state read previews returned handoffs;
  this is full recall — the mirror of `read_concept`.
- `find_concepts(project, query, limit=20)` → newest-first `ConceptSummary` matches (`body_preview` +
  `closed_by`) via substring `LIKE` over title+body (`%`/`_` literal, limit clamped 1-100). Search
  first; `mode:'full'` state only when everything is truly needed.
```

(c) In the `read_project_state` bullet, after "Grouping is by **effective** status:" content ends (before "The viewer groups and badges"), insert:

```markdown
  Takes `mode: full | lean | ids` (default **lean**: previews for durable types — decision/
  architecture/constraint/open_question — heads for note/feature and the archive, compact JSON;
  measured 82→56 KB on the heaviest project). `full` is the pre-mode shape, pretty-printed,
  byte-identical. `ids` is heads + per-status counts.
```

(d) In the scope fence, change `No FTS, no vector/semantic recall, no reranking.` to `No FTS, no vector/semantic recall, no reranking (\`find_concepts\` is plain \`LIKE\` — that is the ceiling).`

- [ ] **Step 3: Update README.md**

The heading is exactly `## MCP tools (six)` (README.md:69). Change it to `## MCP tools (eight)`, add two lines for the new tools following that section's existing format, plus one sentence: `read_project_state defaults to a lean kickoff (durable-type previews; heads for the rest) — find_concepts and read_handoff/read_concept recall anything it elides.`

- [ ] **Step 4: Full suite + verify SERVER_INSTRUCTIONS test**

`tests/loop.test.ts` asserts `SERVER_INSTRUCTIONS` contains `"read_concept"` and other markers (~line 880) — confirm still green. Run: `bun test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts CLAUDE.md README.md
git commit -m "docs(spec-b): six -> eight tools recorded; instructions teach the discovery grammar

Every client learns on connect: lean kickoff by default, find_concepts
before full-state pulls, read_handoff for whole-handoff recall, and that
double-returns are safe. The fence amendment is recorded in CLAUDE.md the
same way the Mermaid carve-out was."
```

---

## Post-implementation (controller)

- Re-measure threadkey lean on a fixture copy (target ≤ 60 KB); real MCP round-trip after respawn.
- Pool captures: supersede-fork the playbook concept ("How to use headwater effectively") with the new grammar; supersede-fork the Spec A shipped concept (Spec B delivered); note for ThreadKey.
