# Design — Discovery (Spec B): read_handoff, find_concepts, state modes

**Date:** 2026-07-10
**Status:** Approved by the operator (design conversation 2026-07-09/10); proceeding to plan
**Source:** ThreadKey brief P1 items 4-7; Spec A's measured non-goal (C2)
**Fence amendment (operator-ratified):** the tool surface grows **six → eight**. `find_concepts` is plain
SQL `LIKE` — the no-FTS fence stands. Recorded in CLAUDE.md like the Mermaid carve-out.

## Why now — measured

Post-Spec-A, `read_project_state("threadkey")` is **82.2 KB** and grows with every write. The dominant
term is `concepts_by_status` — and measurement corrected the design mid-flight: the archive is NOT the
bulk (8 resolved vs **68 active**, of which 27 are `note`s). A lean mode keyed on *archive vs working
set* saves only 5%; keyed on **concept type** it saves 32% and stops growing with note traffic:

| Shape (threadkey, 2026-07-09 data) | Size |
| --- | --- |
| `full`, pretty (today) | 82.2 KB |
| compact JSON alone | 72.0 KB |
| **`lean`: type-selective + compact (ships as default)** | **55.9 KB** |
| `ids` + counts, compact | 32.9 KB |

Honest limit: no server mode bounds a working set the client never closes. `lean` caps the worst growth
class (notes); `find_concepts` removes the reason to ever pull `full`; hygiene (supersede stale notes)
is the client's half.

## The three additions

### 1. `read_handoff(id)` — handoff recall is first-class

Mirrors `read_concept`: unknown id throws; otherwise the full row with `payload_snapshot` parsed and
each carried concept's **full frozen body** (this IS the recall path — nothing previewed), `directive`
and `return_note` whole. Closes the circularity behind ThreadKey's largest outage: handoff data no
longer lives only inside the state read. Implementation: export `readHandoff(db, id)` returning
`presentHandoff(row)`; throw `unknown handoff: <id>` like `returnHandoff` does.

### 2. `find_concepts(project, query, limit=20)` — search, not grep

```sql
SELECT * FROM concept
 WHERE project_id = ? AND (title LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\')
 ORDER BY created_at DESC LIMIT ?
```

- `query` escaped: `q.replace(/[\\%_]/g, m => "\\" + m)`, wrapped `%…%`. A literal `%` in the query
  matches a literal `%` — never a wildcard.
- Empty/whitespace query throws (`find_concepts requires a non-empty query`) — never a full-table dump.
- `limit` clamped to 1–100, default 20.
- Returns `ConceptSummary[]` (heads with `body_preview`) + `closed_by` where derived — enough to pick
  which `read_concept` to issue. SQLite `LIKE` is ASCII-case-insensitive; documented, accepted.
- Same primitive as the viewer's `?q=`; no FTS.

### 3. `read_project_state(project, mode?)` — the C2 fix

`mode: "full" | "lean" | "ids"`, zod enum, **default `lean`**.

| mode | concepts_by_status | serialization |
| --- | --- | --- |
| `lean` (default) | active/locked/parked: **durable types** (`decision`, `architecture`, `constraint`, `open_question`) keep full summaries (`body_preview`); `note`/`feature` become heads. resolved/discarded: heads. | **compact** |
| `full` | today's exact shape | pretty (`null, 2`) — **byte-identical to pre-B output**; the back-compat guarantee and escape hatch |
| `ids` | heads everywhere + `concept_counts` per status | compact |

- Head shape: `{id, type, title, status, created_at, closed_by?}` (= `ConceptHead`).
- `open_handoffs` / `recent_handoffs` / `recent_concepts`: Spec A shapes in every mode, untouched.
- The 128 KB degrade guard applies to ALL modes (mode is presentation; the guard is the backstop).
- Two serialization styles in one tool is deliberate: `full`'s byte-identity is the strongest
  back-compat statement (operator informed, approved).
- Implementation: `readProjectState` unchanged; exported shapers `leanProjectState(state)` /
  `idsProjectState(state)`; `callTool`'s `read_project_state` case picks shape + serialization.

## Wiring, teaching, docs

- Two new `callTool` cases + two `registerTool` blocks — logging and error discipline come free from
  the Spec A dispatcher. Log `op: "read_handoff" | "find_concepts"`; project resolved from the result
  row / args.
- **`SERVER_INSTRUCTIONS` rewritten** to teach the grammar every client learns on connect: kickoff is
  lean by default and carries durable-type previews; `read_concept`/`read_handoff` are full recall;
  `find_concepts` before ever requesting `mode:"full"`.
- CLAUDE.md: "The six MCP tools" → "The eight MCP tools"; the two new tools + `mode` documented; the
  fence amendment recorded as deliberate and operator-approved.
- README: tool list + a discovery paragraph.
- Post-merge (controller, not plan): supersede-fork the in-pool playbook concept ("How to use
  headwater effectively") to teach the new grammar; supersede-fork the Spec A shipped concept's
  "Spec B soon" pointer.

## Error handling

| Condition | Behaviour |
| --- | --- |
| `read_handoff` unknown id | throw → `isError` |
| `find_concepts` empty/whitespace query | throw → `isError` |
| `find_concepts` limit out of range | clamp silently (1–100) |
| `mode` outside enum | zod rejects at the boundary |
| any mode over the 128 KB cap | degrade (unchanged Spec A behavior) |

## Testing (`tests/reliability.test.ts` — the wire-path suite)

- `read_handoff`: round-trips a frozen snapshot with FULL bodies; whole directive/return_note; unknown
  id errors; logged.
- `find_concepts`: finds by title and by body; project-scoped (no cross-project leak); `%`/`_` in the
  query match literally; empty query errors; limit clamps; newest first; `closed_by` present on a
  derived-closed hit.
- Modes: default is lean (no `mode` arg → lean shape); lean previews durable types and heads
  notes/features + archive; `full` output **byte-identical** to a pre-B capture of the same pool;
  `ids` carries `concept_counts` and heads everywhere; lean/ids are compact (no `"\n  "` indent);
  degrade still fires over the cap in lean mode.
- Scale: lean read at 10× under 2 s and under the cap.
- Acceptance re-measured on the live-pool fixture copy: threadkey lean ≤ 60 KB.

## Non-goals

No FTS/vectors (fence). No `server_version`/capability flags (Spec C). No handoff search. No
pagination. No new source files; no new deps; existing six tools' signatures untouched (`mode` and the
two new tools are additive).

## Files touched

- `src/server.ts` — `readHandoff`, `findConcepts`, `leanProjectState`, `idsProjectState`, two
  `callTool` cases + mode handling, two `registerTool` blocks, `SERVER_INSTRUCTIONS` rewrite
- `tests/reliability.test.ts` — new coverage above
- `CLAUDE.md`, `README.md` — the amendment + tool docs
