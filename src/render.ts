// render.ts — the read-only observation page.
//
// Reads the pool and writes a single static index.html: concepts grouped by status, the
// lineage tree (parent -> branches), and the handoff timeline. Plain HTML/CSS built from
// template literals — no framework, no client JS, no write actions. Behaviourally read-only:
// it only issues SELECTs and writes the HTML file; it never mutates pool data.
//
// Regenerate on demand:  bun run render

import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDb, nowIso, CONCEPT_STATUSES } from "./db.ts";
import type { ConceptRow, HandoffRow, LineageRow } from "./db.ts";

type ConceptView = ConceptRow & { origin_label: string; project_name: string };
type LineageView = LineageRow & { child_title: string; parent_title: string };
type HandoffView = HandoffRow & { from_label: string; to_label: string; project_name: string };

// --- small HTML helpers -----------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Cosmetic-only timestamp formatting; falls back to the raw value if it doesn't parse. */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function badge(text: string, className: string): string {
  return `<span class="badge ${className}">${esc(text)}</span>`;
}

// --- data access ------------------------------------------------------------

function loadConcepts(db: Database): ConceptView[] {
  return db
    .query<ConceptView, []>(
      `SELECT c.*, s.label AS origin_label, p.name AS project_name
         FROM concept c
         JOIN surface s ON s.id = c.origin_surface_id
         JOIN project p ON p.id = c.project_id
        ORDER BY c.created_at ASC`,
    )
    .all();
}

function loadLineage(db: Database): LineageView[] {
  return db
    .query<LineageView, []>(
      `SELECT l.*, cf.title AS child_title, ct.title AS parent_title
         FROM lineage l
         JOIN concept cf ON cf.id = l.from_concept_id
         JOIN concept ct ON ct.id = l.to_concept_id
        ORDER BY l.created_at ASC`,
    )
    .all();
}

function loadHandoffs(db: Database): HandoffView[] {
  return db
    .query<HandoffView, []>(
      `SELECT h.*, sf.label AS from_label, st.label AS to_label, p.name AS project_name
         FROM handoff h
         JOIN surface sf ON sf.id = h.from_surface_id
         JOIN surface st ON st.id = h.to_surface_id
         JOIN project p ON p.id = h.project_id
        ORDER BY h.initiated_at ASC`,
    )
    .all();
}

// --- section renderers ------------------------------------------------------

function renderConceptCard(c: ConceptView): string {
  return `
    <article class="card">
      <div class="card-head">
        ${badge(c.type, "type")}
        <h3 class="card-title">${esc(c.title)}</h3>
      </div>
      <p class="card-body">${esc(c.body)}</p>
      <div class="meta">
        <code class="id">${esc(c.id)}</code>
        <span>origin: ${esc(c.origin_label)}</span>
        <span>project: ${esc(c.project_name)}</span>
        <span>${fmtTime(c.created_at)}</span>
      </div>
    </article>`;
}

function renderConceptsSection(concepts: ConceptView[]): string {
  if (concepts.length === 0) {
    return `<section><h2>Concepts</h2><p class="empty">No concepts yet.</p></section>`;
  }
  const groups = CONCEPT_STATUSES.map((status) => {
    const items = concepts.filter((c) => c.status === status);
    if (items.length === 0) return "";
    return `
      <div class="status-group">
        <h3 class="status-head">${badge(status, `st-${status}`)} <span class="count">${items.length}</span></h3>
        <div class="cards">${items.map(renderConceptCard).join("")}</div>
      </div>`;
  }).join("");
  return `<section><h2>Concepts <span class="count">${concepts.length}</span></h2>${groups}</section>`;
}

function renderLineageSection(edges: LineageView[]): string {
  if (edges.length === 0) {
    return `<section><h2>Lineage</h2><p class="empty">No lineage edges yet.</p></section>`;
  }
  // Group edges by parent (to_concept_id): the original is the canonical root, branches hang off it.
  const parents = new Map<string, { title: string; branches: LineageView[] }>();
  for (const e of edges) {
    const entry = parents.get(e.to_concept_id) ?? { title: e.parent_title, branches: [] };
    entry.branches.push(e);
    parents.set(e.to_concept_id, entry);
  }
  const trees = [...parents.entries()]
    .map(([parentId, { title, branches }]) => {
      const rows = branches
        .map(
          (b) => `
          <li class="branch">
            <span class="branch-edge">${badge(b.kind, "edge")}${
              b.reason ? badge(b.reason, "reason") : ""
            }</span>
            <span class="branch-node">${esc(b.child_title)} <code class="id">${esc(b.from_concept_id)}</code></span>
          </li>`,
        )
        .join("");
      return `
        <div class="tree">
          <div class="tree-root">${esc(title)} <code class="id">${esc(parentId)}</code></div>
          <ul class="branches">${rows}</ul>
        </div>`;
    })
    .join("");
  return `<section><h2>Lineage <span class="count">${edges.length}</span></h2>${trees}</section>`;
}

function renderHandoffsSection(handoffs: HandoffView[]): string {
  if (handoffs.length === 0) {
    return `<section><h2>Handoffs</h2><p class="empty">No handoffs yet.</p></section>`;
  }
  const rows = handoffs
    .map((h) => {
      const carried = ((): number => {
        try {
          const parsed = JSON.parse(h.payload_snapshot);
          return Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          return 0;
        }
      })();
      return `
      <article class="handoff">
        <div class="handoff-head">
          <span class="route">${esc(h.from_label)} <span class="arrow">&rarr;</span> ${esc(h.to_label)}</span>
          ${badge(h.status, `ho-${h.status}`)}
        </div>
        <p class="directive">${esc(h.directive)}</p>
        <div class="meta">
          <code class="id">${esc(h.id)}</code>
          <span>project: ${esc(h.project_name)}</span>
          <span>carries: ${carried} concept${carried === 1 ? "" : "s"}</span>
          <span>opened: ${fmtTime(h.initiated_at)}</span>
          ${h.returned_at ? `<span>returned: ${fmtTime(h.returned_at)}</span>` : ""}
        </div>
        ${h.return_note ? `<p class="return-note"><strong>Return note:</strong> ${esc(h.return_note)}</p>` : ""}
      </article>`;
    })
    .join("");
  return `<section><h2>Handoffs <span class="count">${handoffs.length}</span></h2><div class="timeline">${rows}</div></section>`;
}

// --- page assembly ----------------------------------------------------------

const STYLE = `
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1c2330; --muted: #6b7385;
    --line: #e4e7ec; --accent: #2f6f6a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 24px 80px; }
  header.page { border-bottom: 2px solid var(--accent); padding-bottom: 16px; margin-bottom: 8px; }
  header.page h1 { margin: 0; font-size: 26px; letter-spacing: -0.01em; }
  header.page .tag { color: var(--muted); margin-top: 4px; }
  .generated { color: var(--muted); font-size: 13px; margin: 4px 0 28px; }
  section { margin: 34px 0; }
  section > h2 { font-size: 19px; margin: 0 0 14px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .count { display: inline-block; min-width: 20px; padding: 0 7px; border-radius: 999px;
    background: var(--line); color: var(--muted); font-size: 12px; font-weight: 600; vertical-align: middle; }
  .status-group { margin: 18px 0; }
  .status-head { font-size: 14px; margin: 0 0 10px; font-weight: 600; }
  .cards { display: grid; gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card-head { display: flex; align-items: baseline; gap: 10px; }
  .card-title { margin: 0; font-size: 16px; }
  .card-body { margin: 8px 0 10px; color: #333a48; white-space: pre-wrap; }
  .meta { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 12.5px; align-items: center; }
  code.id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
    background: #eef1f4; color: #475067; padding: 1px 6px; border-radius: 5px; }
  .badge { display: inline-block; font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
    padding: 2px 9px; border-radius: 999px; text-transform: lowercase; }
  .badge.type { background: #eaeef3; color: #475067; }
  .badge.edge { background: #e7eef7; color: #34557e; }
  .badge.reason { background: #f1ecf7; color: #6a4b8c; margin-left: 6px; }
  .st-active   { background: #e2f3e8; color: #1f7a47; }
  .st-locked   { background: #e6edfb; color: #2c4fa6; }
  .st-parked   { background: #fbf0dc; color: #9a6b16; }
  .st-resolved { background: #def0ef; color: #1f6f6a; }
  .st-discarded{ background: #eceef1; color: #6b7385; }
  .ho-pending  { background: #fbf0dc; color: #9a6b16; }
  .ho-returned { background: #e2f3e8; color: #1f7a47; }
  .ho-consumed { background: #e6edfb; color: #2c4fa6; }
  .ho-dropped  { background: #eceef1; color: #6b7385; }
  .tree { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 12px; }
  .tree-root { font-weight: 600; }
  .branches { list-style: none; margin: 10px 0 0; padding: 0 0 0 6px; }
  .branch { display: flex; gap: 10px; align-items: baseline; padding: 6px 0 6px 14px;
    border-left: 2px solid var(--line); margin-left: 4px; }
  .branch-node { color: #333a48; }
  .timeline { display: grid; gap: 12px; }
  .handoff { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .handoff-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .route { font-weight: 600; }
  .arrow { color: var(--accent); padding: 0 4px; }
  .directive { margin: 8px 0 10px; color: #333a48; }
  .return-note { margin: 10px 0 0; padding: 8px 12px; background: #f3f6f5; border-radius: 8px; font-size: 14px; }
  .empty { color: var(--muted); font-style: italic; }
`;

/** Build the full observation page from the current pool contents. */
export function renderHtml(db: Database): string {
  const concepts = loadConcepts(db);
  const lineage = loadLineage(db);
  const handoffs = loadHandoffs(db);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>headwater — observation</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header class="page">
      <h1>headwater</h1>
      <div class="tag">the handoff of state between AI surfaces, made observable</div>
    </header>
    <p class="generated">Generated ${fmtTime(nowIso())} · ${concepts.length} concepts · ${lineage.length} lineage edges · ${handoffs.length} handoffs</p>
    ${renderConceptsSection(concepts)}
    ${renderLineageSection(lineage)}
    ${renderHandoffsSection(handoffs)}
  </div>
</body>
</html>
`;
}

/** CLI entry: open the pool, render, and write ./index.html. */
async function main(): Promise<void> {
  const db = initDb();
  const html = renderHtml(db);
  const out = join(process.cwd(), "index.html");
  await Bun.write(out, html);
  console.error(`wrote ${out}`);
}

if (import.meta.main) {
  await main();
}
