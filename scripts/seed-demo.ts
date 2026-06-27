// seed-demo.ts — populate a DISPOSABLE, repo-local demo pool so a fresh clone shows a meaningful
// observation page in one command. Run it with `bun run demo`; serve it with `bun run demo:serve`.
//
// Isolation (never the user's real pool): the demo lives in a repo-local `.demo/` dir (git-ignored),
// resolved relative to the repo root so it works from any CWD. We point the project's own data-dir env
// var (HEADWATER_DATA_DIR) at it, wipe any prior pool first, then repopulate — so re-running gives the
// same shape with no duplicates. Everything is written ONLY through the exported tool functions
// (writeConcept / forkConcept / openHandoff / returnHandoff) — no raw SQL, no new write path.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { initDb, resolveDbPath } from "../src/db.ts";
import { writeConcept, forkConcept, openHandoff, returnHandoff } from "../src/server.ts";

// --- isolated, repo-local pool ------------------------------------------------
const repoRoot = join(import.meta.dir, "..");
const demoDir = join(repoRoot, ".demo");
process.env.HEADWATER_DATA_DIR = demoDir; // the project's data-dir env var, pointed at .demo/

// Fresh start: drop the prior demo pool (and its WAL sidecars) so a re-run is identical, not additive.
for (const f of ["pool.db", "pool.db-wal", "pool.db-shm"]) rmSync(join(demoDir, f), { force: true });

const dbPath = resolveDbPath(); // == <repo>/.demo/pool.db, via HEADWATER_DATA_DIR
const db = initDb(dbPath);

// --- the demo workstream ------------------------------------------------------
// A small, universally legible software effort — a checkout redesign — moving between a planning chat
// and a coding session, with the operator stepping in once. Content is hand-authored and fixed.
const PROJECT = "checkout-redesign";
const DESKTOP = "claude-desktop:checkout"; // the planning chat
const CODE = "claude-code:checkout-redesign"; // the coding session
const OPERATOR = "operator"; // the human, as a first-class surface

const archBody = [
  "The page is one screen, but a small state machine under the hood — each section gates the next, and payment can bounce back to edit. **Why:** explicit states keep validation, analytics, and the browser back button honest.",
  "",
  "```mermaid",
  "stateDiagram-v2",
  "  [*] --> Cart",
  "  Cart --> Contact: checkout",
  "  Contact --> Shipping: continue",
  "  Shipping --> Payment: continue",
  "  Payment --> Review: authorized",
  "  Payment --> Shipping: edit",
  "  Review --> Placed: place order",
  "  Placed --> [*]",
  "```",
].join("\n");

const codeBody = [
  "Adopt Stripe's Payment Element (provider-hosted fields) for card entry. **Why:** it keeps us in PCI SAQ-A, supports 3-D Secure and wallets out of the box, and is the least-effort path that satisfies the no-card-data constraint.",
  "",
  "| Option | PCI scope | Effort |",
  "| --- | --- | --- |",
  "| Stripe Payment Element | SAQ-A | low |",
  "| Hosted redirect | SAQ-A | low, worse UX |",
  "| Custom card form | SAQ-D | high |",
].join("\n");

// 1) The canonical root: a locked planning decision.
const root = writeConcept(db, {
  project: PROJECT,
  type: "decision",
  status: "locked",
  surface: DESKTOP,
  title: "Single-page checkout, not a multi-step wizard",
  body:
    "Collapse checkout into one page with progressively revealed sections (contact → shipping → payment → review), instead of a 3-step wizard. **Why:** every wizard step is a drop-off cliff; one page with the order total always visible reduces surprise and abandonment.",
});

// 2) Architecture (active) — carries the Mermaid checkout state machine.
const arch = writeConcept(db, {
  project: PROJECT,
  type: "architecture",
  status: "active",
  surface: DESKTOP,
  title: "Checkout state machine",
  body: archBody,
});

// 3) A hard constraint (active).
const constraint = writeConcept(db, {
  project: PROJECT,
  type: "constraint",
  status: "active",
  surface: DESKTOP,
  title: "Card data never touches our servers (PCI SAQ-A)",
  body:
    "All card entry happens in a provider-hosted field; our backend only ever sees a token. **Why:** staying in PCI SAQ-A scope avoids the audit burden and liability of handling raw card numbers — a requirement, not a preference.",
});

// 4) An open question, parked pending a product call.
const open = writeConcept(db, {
  project: PROJECT,
  type: "open_question",
  status: "parked",
  surface: DESKTOP,
  title: "Guest checkout, or require an account?",
  body:
    "Allow guest checkout, or force account creation at the payment step? **Tension:** guest checkout lifts conversion now; required accounts lift retention later. Parked pending a product call.",
});

// 5) A decision authored from the coding session — carries the pipe table.
const codeDecision = writeConcept(db, {
  project: PROJECT,
  type: "decision",
  status: "active",
  surface: CODE,
  title: "Use Stripe Payment Element for the payment step",
  body: codeBody,
});

// 6) A fork of the root that SUPERSEDES it — the original stays the canonical root; this is a branch.
//    Shows immutability-via-fork and a real lineage edge.
const superseded = forkConcept(db, {
  parent_id: root.id,
  surface: CODE,
  kind: "supersedes",
  reason: "inference",
  type: "decision",
  title: "Single-page checkout with a one-tap express lane",
  body:
    "Keep the single page, but add an express lane: returning users with a saved card and address place the order in one tap, skipping the section reveal. **Why:** the single-page decision holds, but under-served repeat buyers; the express path refines it without reopening it.",
});

// 7) The operator annotates the architecture — the human-as-surface layer.
const annotation = forkConcept(db, {
  parent_id: arch.id,
  surface: OPERATOR,
  kind: "annotates",
  reason: "observation",
  type: "note",
  title: "Note: payment needs a 3-DS step-up sub-state",
  body:
    "From the payments team: the Payment state must support a 3-D Secure step-up as a sub-state (SCA can interrupt authorization). Worth modeling before build.",
});

// --- handoffs: one closed loop, one open loop --------------------------------
// RETURNED (the centerpiece): planning → code, carrying the key decisions + the constraint to implement;
// returned with a note pointing at what came back (the new code-session decision + the supersede).
const returned = openHandoff(db, {
  project: PROJECT,
  from_surface: DESKTOP,
  to_surface: CODE,
  concept_ids: [root.id, arch.id, constraint.id],
  directive:
    "Implement the single-page checkout: build the state machine, and keep all card data in provider-hosted fields (SAQ-A). Flag anything that forces a wizard or widens PCI scope.",
});
returnHandoff(db, {
  handoff_id: returned.id,
  return_note:
    "Implemented. Payment step uses the Stripe Payment Element (SAQ-A held), and the single-page flow gained a one-tap express lane for returning users — a supersede of the original decision. Both are recorded in the pool.",
});

// PENDING (open loop): code → planning, carrying the open question, asking for a product call. Unreturned.
openHandoff(db, {
  project: PROJECT,
  from_surface: CODE,
  to_surface: DESKTOP,
  concept_ids: [open.id],
  directive:
    "Product call needed before the payment step is final: guest checkout, or require an account? This blocks the contact → payment gating. Please decide.",
});

// --- summary ------------------------------------------------------------------
const concepts = [root, arch, constraint, open, codeDecision, superseded, annotation];
db.close();

console.log(`\nheadwater demo seeded → ${dbPath}`);
console.log(`  project:   ${PROJECT}`);
console.log(`  concepts:  ${concepts.length}  (decisions, architecture, constraint, open question, a supersede + an operator annotation)`);
console.log(`  handoffs:  2  (1 returned, 1 pending)`);
console.log(`\nNext:  bun run demo:serve    then open  http://127.0.0.1:8765\n`);
