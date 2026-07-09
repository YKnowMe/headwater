# Design — Reliability hardening (Spec A: write-path safety & size discipline)

**Date:** 2026-07-09
**Status:** Proposed — decisions settled with the operator; awaiting spec review, then implementation
**Source:** development brief from the ThreadKey Strategy surface (headwater's heaviest client), 2026-07-09
**Scope:** Spec A only. Specs B (discovery) and C (identity) are named here as non-goals and get their
own cycles.

## Findings — verified, not assumed

The brief asked that its claims be checked against the code before acting. They were. Three results
change what we build.

### 1. The hung `return_handoff` on `handoff-f412852b` DID commit

```
status       = returned
returned_at  = 2026-07-09T05:27:46.321Z
return_note  = the full 1,563-byte Round 5 note
```

Wedge #1's precedent ("the hung write never committed") does **not** generalize. The write landed; only
the response never arrived. **ThreadKey must not re-file that note.**

### 2. A retried `return_handoff` destroys the record — the emergency

`returnHandoff` (`src/server.ts:343`) is a bare `UPDATE` with no status guard. The substrate does not
stop it either: `handoff_frozen_update` (`src/db.ts:199`) protects only the frozen columns, so
`returned → returned` passes straight through. Tested against a copy of the live pool:

| | `returned_at` | note length |
| --- | --- | --- |
| before retry | `2026-07-09T05:27:46.321Z` | 1563 |
| after retry | `2026-07-09T07:27:26.499Z` | 50 |

The retry overwrote the Round 5 note. Silently. Exit 0.

So the situation is worse than "unsafe retries": **the one recovery action a client naturally takes
after a hang is the action that erases the record it was trying to confirm.** ThreadKey's note survives
only because nobody retried. In a tool whose premise is immutability, the single `UPDATE` path is
unguarded.

**This reorders the brief's P0. Idempotency is item 1, not item 3.** Even if the wedge is never
reproduced — it may live in the client relay, which we do not control — retry-safety downgrades a hang
from a coordination outage to a retry.

### 3. The payload is bigger than measured, and the dominant term is not handoffs

`read_project_state("threadkey")` is **105.9 KB** (the brief measured ~86 KB).

| Section | Size | |
| --- | --- | --- |
| `concepts_by_status` | 61.8 KB | 83 concepts × ~727 B, **grows with every write** |
| `recent_handoffs` | 32.5 KB | pending handoffs duplicated from `open_handoffs` |
| `recent_concepts` | 7.2 KB | **entirely duplicated** — every one is already in `concepts_by_status` |
| `open_handoffs` | 1.8 KB | |

`src/server.ts:176` states the cause outright: *"directive/return_note stay whole."* The
`recent_concepts` duplication is a finding the brief did not have.

### 4. Two hypotheses cheaply eliminated

- **Not a stderr-pipe wedge.** The server writes to stderr exactly once, at startup
  (`src/server.ts:536`). Nothing accumulates.
- **Not response size, for wedge #2.** The `return_handoff` echo is 15.2 KB, and the 105.9 KB state read
  *succeeded* immediately before it. A 15 KB write does not block a pipe.

**The mechanism of wedge #2 remains open.** We instrument rather than guess. This spec does not claim to
fix it.

## Decisions

1. **Idempotent-if-identical, conflict-if-different.** A retry carrying the same note succeeds as a
   no-op; a retry carrying a different note is refused. Never overwrite.
2. **One-way transition enforced at the substrate**, like concept immutability — a raw `sqlite3` edit
   fails too.
3. **Bound returned handoffs; keep pending handoffs whole.** A pending directive is the actionable
   payload the receiver must read. A returned handoff is archive.
4. **Log to a file, never to stderr.** See the trap below.
5. **The size guard degrades; it never errors.** An error at the cap is a total outage.
6. **No new tools and no new source files.** The six-tool surface holds and nothing is added under
   `src/`. One new *test* file (`tests/reliability.test.ts`) is added — the same recorded exception
   `tests/backup.test.ts` already set. The logger lives inside `src/server.ts`; the 10× fixture is
   generated inside the test, not checked in.

## Design

### Component 1 — write-path safety

`returnHandoff(db, args)` reads the handoff first, then branches:

| `status` | retry note vs stored | Behaviour |
| --- | --- | --- |
| `pending` | — | `UPDATE` as today; return the handoff |
| `returned` | identical | **no `UPDATE` at all**; return the stored handoff with `already_returned: true` |
| `returned` | different | throw → `isError`, naming the stored `returned_at` |
| unknown id | — | throw, as today |

The conflict message must leave a stuck client able to proceed — it states that the handoff is already
closed and when, so the client knows its original write succeeded:

```
handoff handoff-f412852b was already returned at 2026-07-09T05:27:46.321Z with a different
note; refusing to overwrite. The earlier return stands. If this note adds something, record it
as a concept instead.
```

"Identical" means exact string equality on `return_note`. No normalisation: whitespace is meaning in a
note, and a silent "close enough" match is the failure mode we are removing.

Behind the tool, **schema v3** adds:

```sql
CREATE TRIGGER IF NOT EXISTS handoff_return_is_one_way
  BEFORE UPDATE ON handoff
  WHEN OLD.status <> 'pending' OR NEW.status <> 'returned'
  BEGIN SELECT RAISE(ABORT, 'handoff return is one-way: only pending -> returned'); END;
```

The tool short-circuits before the `UPDATE`, so the trigger is a backstop, not the mechanism.

**Accepted trade-off:** this trigger encodes v1's only transition. The `consumed` / `dropped` statuses
that `CLAUDE.md` calls "intentional headroom" become unreachable until the trigger is revised — which
is itself a recorded, deliberate act, exactly as the immutability triggers already require. That is the
right default: the headroom has no tool driving it, and an unguarded `UPDATE` path just cost us a
near-miss on institutional memory.

`SCHEMA_VERSION` goes 2 → 3. `schemaSql()` uses `IF NOT EXISTS` throughout, so an existing v2 pool gains
the trigger on its next open. Triggers affect only future updates; existing rows are untouched.

### Component 2 — response-size discipline

**In `read_project_state`:**

- `recent_handoffs` excludes `pending` (they are already in `open_handoffs`). Dedupe.
- `open_handoffs` (pending): `directive` stays **whole**; `payload_snapshot` concepts keep `body_preview`
  as today. This is the actionable payload.
- `recent_handoffs` (returned): `directive_preview` and `return_note_preview` (280 chars, reusing the
  existing `PREVIEW_CHARS`); `payload_snapshot` reduced to `{id, title}` per concept.
- `recent_concepts`: reduced to `{id, type, title, status, created_at}` — `body_preview` dropped, since
  every one of these concepts already appears in full-summary form in `concepts_by_status`.

**In the mutation tools:**

- `open_handoff` and `return_handoff` stop echoing the full frozen row. They return a confirmation:
  `{id, project_id, from_surface_id, to_surface_id, status, initiated_at, returned_at?, concept_ids,
  already_returned?}`. The caller supplied the directive and the concept ids; echoing a 10 KB frozen
  snapshot back at them is pure waste.

**Projected effect on `read_project_state("threadkey")`, measured against a copy of the live pool:**

| Section | Before | After |
| --- | --- | --- |
| `concepts_by_status` | 61.8 KB | 61.8 KB (untouched) |
| `recent_handoffs` | 32.5 KB | 8.4 KB |
| `recent_concepts` | 7.2 KB | ~1 KB |
| `open_handoffs` | 1.8 KB | 1.8 KB |
| **total** | **105.9 KB** | **~73 KB** (−31%) |

### Component 3 — the total-size guard (degrade, never error)

After building the response, measure the serialized bytes. If it exceeds
`HEADWATER_MAX_RESPONSE_BYTES` (default **131072**, i.e. 128 KB), rebuild it in degraded form:
concepts and handoffs as `{id, title}` plus per-status counts, with

```json
{ "degraded": true,
  "notice": "response exceeded 131072 bytes; concepts and handoffs reduced to ids and titles. Use read_concept(id) for full text." }
```

and a `WARN` line in the log. **The guard never returns an error.** An error at the cap means the client
cannot cold-start at all — trading a slow kickoff for no kickoff. Degrading keeps the surface alive.

This is the brief's item 6 minus the `mode` parameter, which belongs to Spec B.

### Component 4 — instrumentation, and the trap it must avoid

One JSONL line per tool call, appended to `<data dir>/headwater.log`:

```json
{"ts":"2026-07-09T07:41:02.114Z","op":"return_handoff","project":"threadkey","ok":true,
 "ms":3,"req_bytes":1620,"resp_bytes":412,"degraded":false}
```

`req_bytes` is `JSON.stringify(args).length` — the tool's arguments as received, not the raw JSON-RPC
frame, which the SDK owns and we cannot see. `resp_bytes` is the length of the `text` we hand back:
exactly what gets written to stdout, which is the number the wedge hypotheses care about. `project` is
absent for ops that carry no project (`read_concept`, `fork_concept`, `return_handoff` — the last two
resolve it from the parent row, so it is filled in after the lookup where available). `ok:false` lines
carry an `error` field with the message.

**It must not go to stderr.** The server writes stderr exactly once today. If we begin logging every
request there and the client never drains that pipe, the 64 KB stderr buffer fills, `console.error`
blocks forever, and every later request queues behind it — **we would create a wedge while hunting one.**
A file sidesteps the transport entirely.

Logging must never throw and never fail a request: wrap in `try/catch` and swallow. Use `appendFileSync`
— a few hundred bytes to a local file, well under the latency that matters here.

Log growth is unbounded; at ThreadKey's velocity that is kilobytes per day and not worth a rotation
mechanism yet. Noted, not built.

### Component 5 — wedge reproduction

Build a synthetic pool at ~10× current scale (≈600 concepts, ≈50 handoffs with 5 KB directives) inside
the test file — no new script, no fixture checked in. Then soak the wedge pattern: heavy
`read_project_state` immediately followed by `return_handoff`, repeated.

- **If it reproduces:** pin it as a regression test and fix it.
- **If it does not:** say so plainly. The log will show where the time goes. The mechanism then most
  likely lives in the client relay, which we do not control, and the mitigation is exactly what this
  spec ships — small responses and safe retries.

We are **not** building the stdout write deadline yet. Wrapping the SDK's `StdioServerTransport` is
invasive, and once responses are a few KB it is likely moot. Measure first. If the repro shows a
blocking write, it becomes its own change.

## Error handling

| Condition | Behaviour |
| --- | --- |
| `return_handoff` on unknown id | throw → `isError` (unchanged) |
| `return_handoff`, already returned, identical note | success, `already_returned: true`, no write |
| `return_handoff`, already returned, different note | throw → `isError`, states the stored `returned_at` |
| any handoff `UPDATE` violating one-way | `RAISE(ABORT)` at the substrate |
| response over the byte cap | degrade to ids+titles+counts, `degraded: true`, WARN in log |
| log write fails | swallowed; the request still succeeds |

## Back-compatibility

The brief's C5 requires additive change, and live surfaces must keep working after nothing but a
respawn. Two response shapes do narrow, deliberately:

- `recent_handoffs[].directive` → `directive_preview`; `return_note` → `return_note_preview`;
  `payload_snapshot` entries → `{id, title}`.
- `recent_concepts[]` loses `body_preview`.

Both are consumed by an LLM reading JSON, not by code with a fixed schema, and both narrow only the
*archive* view. Nothing actionable is removed: a pending handoff's directive stays whole, and every
`recent_concepts` entry appears in full-summary form in `concepts_by_status`. Tool names, argument
names, and argument types are untouched — no signature changes.

## Testing

`tests/reliability.test.ts` (new file; `bun:test`, temp pools throughout, never the real pool).

- Retry with an identical note is a no-op: `already_returned: true`, `returned_at` unchanged, **no
  `UPDATE` issued** (assert the stored note and timestamp are byte-identical).
- Retry with a different note throws, names the stored `returned_at`, and leaves the stored note intact.
  **This is the regression test for the data-loss bug.**
- The substrate refuses `returned → returned` even via raw SQL (drop the tool, use `db.query`).
- The substrate refuses `pending → pending` and `pending → consumed`.
- `pending → returned` still works (the existing loop must not break).
- `recent_handoffs` never contains a `pending` handoff; `open_handoffs` does.
- A returned handoff in `recent_handoffs` carries `directive_preview`, not `directive`; a pending one in
  `open_handoffs` carries the whole `directive`.
- `payload_snapshot` in `recent_handoffs` is `{id, title}` only.
- Over-cap response degrades: `degraded: true`, ids+titles present, size under the cap.
- Under-cap response has no `degraded` key.
- The log file gains one JSONL line per call, parseable, with `op`/`ms`/`resp_bytes`.
- A log write failure (point `HEADWATER_DATA_DIR` at an unwritable path) does not fail the request.
- Scale + soak: ≈600 concepts / ≈50 handoffs; `read_project_state` under 2 s; repeated read→write.

`tests/loop.test.ts` is updated where the response shape changed. No test is weakened to accommodate a
change.

## Acceptance

- No retry can destroy a return note — enforced in the tool **and** at the substrate.
- `read_project_state("threadkey")` under 80 KB and under 2 s; under 2 s at 10× scale.
- Every tool call produces exactly one log line.
- Double-return is safe.
- All three live surfaces work after nothing but a respawn.
- Whether wedge #2 reproduces is **reported honestly either way**.

## Non-goals (explicit)

- **C2 is not solved.** `concepts_by_status` is 61.8 KB, the dominant and monotonically growing term,
  and Spec A does not touch it. The structural fix is `read_project_state(mode)` — **Spec B**. At
  ThreadKey's velocity this spec buys roughly a year, not forever. The degradation guard is the
  backstop, not a solution.
- `read_handoff(id)`, `find_concepts(project, query)`, `mode` parameter — Spec B.
- Surface/project aliasing, `merge_project` / `merge_surface`, `server_version` + capability flags —
  Spec C. (Version advertisement is cheap and high value; it is deferred only to keep this change small.)
- `client_request_id` dedupe on `write_concept` / `open_handoff` — deferred. `return_handoff` is the one
  mutating op whose retry was destructive; the others append, so a duplicate is visible and forkable
  rather than silent.
- The stdout write deadline — measure first.
- Handoff supersede/cancel primitive — Spec B or later.

## Files touched

- `src/db.ts` — `SCHEMA_VERSION` 2 → 3; the `handoff_return_is_one_way` trigger
- `src/server.ts` — `returnHandoff` guard; state-shape changes; mutation-response slimming; the size
  guard; per-request file logging
- `tests/reliability.test.ts` — new
- `tests/loop.test.ts` — updated for changed response shapes
- `CLAUDE.md` — the one-way invariant, the log file, the size guard
- `README.md` — the log file and the size guard
