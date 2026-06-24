// render.ts — the read-only observation page.
//
// `bun run render` reads the pool and writes a single static index.html (pure HTML/CSS from
// template literals — no client JS): concepts grouped by status, the lineage tree
// (parent -> branches), and the handoff timeline.
//
// `bun run serve` starts a tiny local viewer (Bun.serve) that re-renders the same page from the
// pool on every request; in that live mode the page carries a single vanilla-JS Refresh button
// (location.reload()) — no framework. Either way it is read-only: only SELECTs, never mutates pool data.
//
// Regenerate the file:  bun run render        Live view:  bun run serve

import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDb, nowIso, CONCEPT_STATUSES, CONCEPT_TYPES } from "./db.ts";
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

/** Collapse internal whitespace so a CSS line-clamp truncates clean single-spaced text. */
function flatPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** Truncate a label to n chars (SVG has no line-clamp). Caller still esc()s the result. */
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Render a concept body. Short bodies stay a plain paragraph; long ones (> BODY_CLAMP chars) become a
 * native <details> disclosure: a line-clamped preview that expands in place to the full, height-capped
 * body — so one huge concept can never dominate the page. No JS — <details>/<summary> + CSS only.
 */
const BODY_CLAMP = 280;
function renderBody(body: string): string {
  if (body.length <= BODY_CLAMP) return `<p class="card-body">${esc(body)}</p>`;
  return `<details class="card-body"><summary class="body-summary">${esc(flatPreview(body))}</summary><div class="body-full">${esc(body)}</div></details>`;
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
      ${renderBody(c.body)}
      <div class="meta">
        <code class="id">${esc(c.id)}</code>
        <span>origin: ${esc(c.origin_label)}</span>
        <span>project: ${esc(c.project_name)}</span>
        <span>${fmtTime(c.created_at)}</span>
      </div>
    </article>`;
}

// Cap how many cards a single status group renders inline; the rest tuck behind a CSS-only "show
// more" disclosure so a 200-concept group can't blow out the page (every card stays one click away).
const CARD_CAP = 12;

function renderCards(items: ConceptView[]): string {
  const cards = items.map(renderConceptCard);
  if (cards.length <= CARD_CAP) return `<div class="cards">${cards.join("")}</div>`;
  const head = cards.slice(0, CARD_CAP).join("");
  const rest = cards.slice(CARD_CAP).join("");
  return `<div class="cards">${head}</div><details class="more"><summary>Show ${cards.length - CARD_CAP} more</summary><div class="cards">${rest}</div></details>`;
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
        ${renderCards(items)}
      </div>`;
  }).join("");
  return `<section><h2>Concepts <span class="count">${concepts.length}</span></h2>${groups}</section>`;
}

/** Sticky toolbar content: pool scale + per-status tallies, so the reader gets shape at a glance. */
function renderOverview(concepts: ConceptView[], projectCount: number, lineageCount: number, handoffCount: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const tallies = CONCEPT_STATUSES.map((s) => [s, concepts.filter((c) => c.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${badge(s, `st-${s}`)} <span class="count">${n}</span>`)
    .join(" ");
  return `<div class="overview">
      <span class="scale">${plural(projectCount, "project")} · ${plural(concepts.length, "concept")} · ${plural(lineageCount, "lineage edge")} · ${plural(handoffCount, "handoff")}</span>
      <span class="tallies">${tallies}</span>
    </div>`;
}

function renderLineageSection(edges: LineageView[], key: string): string {
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
  // Exclusive switch: tree (as-is) | diagram | table — same lineage, one representation at a time.
  const g = `lin-${esc(key)}`;
  const views =
    `<details class="view" name="${g}" open><summary>Tree</summary>${trees}</details>` +
    `<details class="view" name="${g}"><summary>Diagram</summary>${buildLineageSvg(parents)}</details>` +
    `<details class="view" name="${g}"><summary>Table</summary>${renderLineageTable(edges)}</details>`;
  return `<section><h2>Lineage <span class="count">${edges.length}</span></h2><div class="switch">${views}</div></section>`;
}

function renderHandoffCard(h: HandoffView): string {
  const carried = carriedCount(h.payload_snapshot);
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
}

/**
 * Handoffs as an exclusive switch (cards | table | timeline) — the same data, one representation at a
 * time. Native <details name=...> makes the group mutually exclusive, no client JS. Cards open by default.
 */
function renderHandoffsSection(handoffs: HandoffView[], key: string): string {
  if (handoffs.length === 0) {
    return `<section><h2>Handoffs</h2><p class="empty">No handoffs yet.</p></section>`;
  }
  const g = `ho-${esc(key)}`;
  const cards = `<div class="timeline">${handoffs.map(renderHandoffCard).join("")}</div>`;
  const svg = buildHandoffTimelineSvg(handoffs);
  const views =
    `<details class="view" name="${g}" open><summary>Cards</summary>${cards}</details>` +
    `<details class="view" name="${g}"><summary>Table</summary>${renderHandoffTable(handoffs)}</details>` +
    (svg ? `<details class="view" name="${g}"><summary>Timeline</summary>${svg}</details>` : "");
  return `<section><h2>Handoffs <span class="count">${handoffs.length}</span></h2><div class="switch">${views}</div></section>`;
}

// --- Phase 2: collapsed on-demand views — tables, inline-SVG diagrams, schema panel ----------

function carriedCount(payload: string): number {
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Dense handoff table (one representation of the switch). */
function renderHandoffTable(handoffs: HandoffView[]): string {
  const rows = handoffs
    .map(
      (h) => `<tr>
        <td>${esc(h.from_label)} &rarr; ${esc(h.to_label)}</td>
        <td>${badge(h.status, `ho-${h.status}`)}</td>
        <td class="num">${carriedCount(h.payload_snapshot)}</td>
        <td>${fmtTime(h.initiated_at)}</td>
        <td>${fmtTime(h.returned_at)}</td>
        <td class="clamp2">${esc(h.directive)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="htbl"><thead><tr><th>route</th><th>status</th><th>carries</th><th>opened</th><th>returned</th><th>directive</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Each handoff as a horizontal lifeline on a shared time axis. Pure inline SVG, no library. */
function buildHandoffTimelineSvg(handoffs: HandoffView[]): string {
  const times: number[] = [];
  for (const h of handoffs) {
    const a = Date.parse(h.initiated_at);
    if (Number.isFinite(a)) times.push(a);
    if (h.returned_at) {
      const b = Date.parse(h.returned_at);
      if (Number.isFinite(b)) times.push(b);
    }
  }
  if (times.length === 0) return "";
  const min = Math.min(...times);
  let max = Math.max(...times);
  if (max === min) max = min + 1; // avoid divide-by-zero
  const W = 720, ROW = 26, PADX = 150, PADR = 24, top = 14;
  const H = top + handoffs.length * ROW + 12;
  const x = (t: number) => PADX + ((t - min) / (max - min)) * (W - PADX - PADR);
  const body = handoffs
    .map((h, i) => {
      const y = top + i * ROW + ROW / 2;
      const a = Date.parse(h.initiated_at);
      const bRaw = h.returned_at ? Date.parse(h.returned_at) : max;
      const ax = Number.isFinite(a) ? x(a) : PADX;
      const bx = Number.isFinite(bRaw) ? x(bRaw) : x(max);
      const cls = `ho-${h.status}`;
      const dash = h.status === "pending" ? ` stroke-dasharray="3 3"` : "";
      const ret = h.returned_at ? `<circle cx="${bx.toFixed(1)}" cy="${y}" r="4" class="tl-ret"/>` : "";
      return `<text x="8" y="${y + 4}" class="tl-label">${esc(clip(`${h.from_label} → ${h.to_label}`, 22))}</text>
        <line x1="${ax.toFixed(1)}" y1="${y}" x2="${bx.toFixed(1)}" y2="${y}" class="tl-line ${cls}"${dash}/>
        <circle cx="${ax.toFixed(1)}" cy="${y}" r="4" class="tl-open"/>${ret}`;
    })
    .join("");
  return `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="handoff timeline">${body}</svg>`;
}

/** Lineage as a relational companion to the text tree: child -> edge -> parent rows. */
function renderLineageTable(edges: LineageView[]): string {
  const rows = edges
    .map(
      (e) => `<tr>
        <td>${esc(e.child_title)} <code class="id">${esc(e.from_concept_id)}</code></td>
        <td>${badge(e.kind, "edge")}${e.reason ? badge(e.reason, "reason") : ""}</td>
        <td>${esc(e.parent_title)} <code class="id">${esc(e.to_concept_id)}</code></td>
        <td>${fmtTime(e.created_at)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="ltbl"><thead><tr><th>child</th><th>edge</th><th>parent</th><th>when</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function lineageNode(x: number, y: number, w: number, label: string, isRoot: boolean): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="24" rx="6" class="ln-node${isRoot ? " ln-root" : ""}"/>` +
    `<text x="${x + 8}" y="${y + 16}" class="ln-text">${esc(clip(label, 26))}</text>`
  );
}

/** Hand-built SVG of the parent->branches forest: each root box links to its child boxes. No library. */
function buildLineageSvg(parents: Map<string, { title: string; branches: LineageView[] }>): string {
  const trees = [...parents.values()];
  if (trees.length === 0) return "";
  const W = 720, ROW = 34, NODEW = 200, GAP = 16, x0 = 12, x1 = x0 + NODEW + 60;
  let y = 12;
  const parts: string[] = [];
  for (const t of trees) {
    const k = Math.max(1, t.branches.length);
    const rootY = y + ((k - 1) * ROW) / 2;
    parts.push(lineageNode(x0, rootY, NODEW, t.title, true));
    t.branches.forEach((b, j) => {
      const cy = y + j * ROW;
      parts.push(
        `<path d="M ${x0 + NODEW} ${rootY + 12} C ${x0 + NODEW + 30} ${rootY + 12}, ${x1 - 30} ${cy + 12}, ${x1} ${cy + 12}" class="ln-edge"/>`,
      );
      parts.push(lineageNode(x1, cy, NODEW, b.child_title, false));
    });
    y += k * ROW + GAP;
  }
  return `<svg class="lineage-svg" viewBox="0 0 ${W} ${y + 8}" role="img" aria-label="lineage tree">${parts.join("")}</svg>`;
}

/** Compact type x status grid: at-a-glance shape of a project's concepts. Collapsed by default. */
function renderMatrix(concepts: ConceptView[]): string {
  if (concepts.length === 0) return "";
  const counts = new Map<string, number>();
  for (const c of concepts) {
    const key = `${c.type}|${c.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const head = CONCEPT_STATUSES.map((s) => `<th>${badge(s, `st-${s}`)}</th>`).join("");
  const rows = CONCEPT_TYPES.map((t) => {
    const cells = CONCEPT_STATUSES.map((s) => {
      const n = counts.get(`${t}|${s}`) ?? 0;
      return n > 0 ? `<td class="num">${n}</td>` : `<td class="num zero">·</td>`;
    }).join("");
    return `<tr><th class="rt">${esc(t)}</th>${cells}</tr>`;
  }).join("");
  return `<details class="view matrix-wrap"><summary>Type × status</summary><table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></details>`;
}

// One-line purpose for each of the six tables — a self-documenting panel for the page.
const SCHEMA_DOC: ReadonlyArray<readonly [string, string]> = [
  ["project", "scope; one per repo / workstream"],
  ["surface", "a participant — a Claude surface or the operator"],
  ["concept", "the immutable unit of recorded state"],
  ["lineage", "append-only edges, child → parent"],
  ["handoff", "a surface-to-surface transition with a frozen payload"],
  ["handoff_concept", "join: which concepts a handoff carries"],
];

function tableCounts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t] of SCHEMA_DOC) {
    out[t] = (db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0);
  }
  return out;
}

/** Collapsed self-documenting panel: the six tables, their purpose, and live row counts. */
function renderSchemaPanel(counts: Record<string, number>): string {
  const rows = SCHEMA_DOC.map(
    ([t, purpose]) => `<tr><td><code>${t}</code></td><td>${esc(purpose)}</td><td class="num">${counts[t] ?? 0}</td></tr>`,
  ).join("");
  return `<details class="schema"><summary>Schema &amp; counts</summary><table class="schema-tbl"><thead><tr><th>table</th><th>purpose</th><th>rows</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

// --- project grouping -------------------------------------------------------
// The pool is shared across projects; the page must not commingle them. Partition every loaded row
// into per-project buckets and render one collapsible section each, so a concept can never appear
// under another project's heading.

type ProjectBucket = { id: string; name: string; concepts: ConceptView[]; edges: LineageView[]; handoffs: HandoffView[] };

/**
 * Bucket concepts/lineage/handoffs by project, sorted by project name. Concepts and handoffs carry
 * `project_id` directly; lineage edges do not, so each is attributed to its child concept's project —
 * safe because the fork invariant keeps a child and its parent in the same project.
 */
function groupByProject(concepts: ConceptView[], lineage: LineageView[], handoffs: HandoffView[]): ProjectBucket[] {
  const names = new Map<string, string>();
  const projectOfConcept = new Map<string, string>();
  for (const c of concepts) {
    names.set(c.project_id, c.project_name);
    projectOfConcept.set(c.id, c.project_id);
  }
  for (const h of handoffs) if (!names.has(h.project_id)) names.set(h.project_id, h.project_name);

  const buckets = new Map<string, ProjectBucket>();
  const bucket = (pid: string): ProjectBucket => {
    let b = buckets.get(pid);
    if (!b) {
      b = { id: pid, name: names.get(pid) ?? pid, concepts: [], edges: [], handoffs: [] };
      buckets.set(pid, b);
    }
    return b;
  };
  for (const c of concepts) bucket(c.project_id).concepts.push(c);
  for (const h of handoffs) bucket(h.project_id).handoffs.push(h);
  for (const e of lineage) {
    const pid = projectOfConcept.get(e.from_concept_id);
    if (pid) bucket(pid).edges.push(e);
  }
  return [...buckets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One project's whole slice: a collapsible section wrapping its concepts, lineage, and handoffs.
 *  `open` is decided by the caller — small pools stay expanded, large ones collapse to a scannable index. */
function renderProjectSection(p: ProjectBucket, opts: { live?: boolean }, open: boolean): string {
  const counts = `${p.concepts.length}c · ${p.edges.length}l · ${p.handoffs.length}h`;
  const focus = opts.live ? ` <a class="focus" href="/?project=${encodeURIComponent(p.id)}">focus</a>` : "";
  return `
    <details class="project" id="proj-${esc(p.id)}"${open ? " open" : ""}>
      <summary><span class="proj-name">${esc(p.name)}</span> <span class="count">${counts}</span>${focus}</summary>
      ${renderConceptsSection(p.concepts)}
      ${renderMatrix(p.concepts)}
      ${renderLineageSection(p.edges, p.id)}
      ${renderHandoffsSection(p.handoffs, p.id)}
    </details>`;
}

/** The project switcher row: jump-anchors in the static file, ?project= links in the live viewer. */
function renderProjectIndex(projects: ProjectBucket[], opts: { live?: boolean; only?: string }): string {
  if (projects.length < 2) return "";
  const chips = projects
    .map((p) => {
      const href = opts.live ? `/?project=${encodeURIComponent(p.id)}` : `#proj-${esc(p.id)}`;
      const active = opts.only === p.id ? " active" : "";
      return `<a class="proj-chip${active}" href="${href}">${esc(p.name)}</a>`;
    })
    .join("");
  const allLink = opts.live && opts.only ? `<a class="proj-chip" href="/">all projects</a>` : "";
  return `<nav class="proj-index">${chips}${allLink}</nav>`;
}

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
  .head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .refresh { cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: #fff;
    font: inherit; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; white-space: nowrap; }
  .refresh:hover { background: #245751; border-color: #245751; }
  .refresh:active { transform: translateY(1px); }
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

  /* Sticky toolbar: pool-scale overview + the project switcher ride along as you scroll. */
  .toolbar { position: sticky; top: 0; z-index: 5; background: var(--bg);
    padding: 10px 0 8px; margin-bottom: 14px; border-bottom: 1px solid var(--line); }
  .overview { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; }
  .overview .scale { font-size: 13px; font-weight: 600; color: var(--ink); }
  .overview .tallies { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

  /* "Show more" disclosure for an over-long status group — every card stays one click away. */
  .more { margin-top: 12px; }
  .more > summary { cursor: pointer; list-style: none; color: var(--accent);
    font-size: 13px; font-weight: 600; padding: 6px 0; }
  .more > summary::-webkit-details-marker { display: none; }
  .more > summary::before { content: "\\25B8  "; color: var(--muted); }
  .more[open] > summary::before { content: "\\25BE  "; }
  .more .cards { margin-top: 12px; }

  /* Per-project sections: the shared pool's projects are visually contained, not commingled. */
  .proj-index { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; }
  .proj-chip { font-size: 13px; padding: 4px 11px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--panel); color: var(--accent); text-decoration: none; }
  .proj-chip:hover { border-color: var(--accent); }
  .proj-chip.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  details.project { border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
    padding: 4px 20px 12px; margin: 22px 0; }
  details.project > summary { font-size: 18px; font-weight: 700; cursor: pointer; list-style: none;
    display: flex; align-items: center; gap: 12px; padding: 12px 0; }
  details.project > summary::-webkit-details-marker { display: none; }
  details.project .proj-name::before { content: "\\25B8  "; color: var(--muted); }
  details.project[open] > summary .proj-name::before { content: "\\25BE  "; }
  details.project .focus { margin-left: auto; font-size: 12px; font-weight: 600;
    color: var(--accent); text-decoration: none; }
  details.project > section:first-of-type { margin-top: 6px; }

  /* Long concept bodies: collapsed to a clamped preview; expanded body is height-capped so no single
     concept can dominate the page. Native details/summary + CSS line-clamp — no JS. */
  details.card-body { margin: 8px 0 10px; }
  details.card-body > summary { color: #333a48; white-space: pre-wrap; cursor: pointer; list-style: none;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  details.card-body > summary::-webkit-details-marker { display: none; }
  details.card-body > summary::after { content: " \\2026 more"; color: var(--muted); font-size: 12px; }
  details.card-body[open] > summary { display: none; }
  details.card-body .body-full { color: #333a48; white-space: pre-wrap; max-height: 60vh; overflow: auto; }

  /* Phase 2: collapsed on-demand views — tables, SVG diagrams, schema panel. */
  details.view, details.schema { margin: 10px 0; }
  details.view > summary, details.schema > summary { cursor: pointer; list-style: none;
    color: var(--accent); font-size: 13px; font-weight: 600; padding: 5px 0; }
  details.view > summary::-webkit-details-marker, details.schema > summary::-webkit-details-marker { display: none; }
  details.view > summary::before, details.schema > summary::before { content: "\\25B8  "; color: var(--muted); }
  details.view[open] > summary::before, details.schema[open] > summary::before { content: "\\25BE  "; }
  details.schema { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; margin: 0 0 18px; }

  /* Representation switch: tree|diagram|table (lineage) and cards|table|timeline (handoffs) are an
     exclusive group via the native details[name] grouping; the summaries read as selectable pills. No JS. */
  .switch { margin: 8px 0 0; }
  .switch > details.view > summary { display: inline-block; padding: 3px 12px; margin: 0 0 8px;
    border: 1px solid var(--line); border-radius: 999px; color: var(--accent); font-weight: 600; }
  .switch > details.view > summary::before { content: ""; margin: 0; }
  .switch > details.view[open] > summary { background: var(--accent); color: #fff; border-color: var(--accent); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0 2px; }
  thead th { position: sticky; top: 0; background: var(--panel); text-align: left;
    font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted);
    border-bottom: 1px solid var(--line); padding: 6px 8px; }
  tbody td, tbody th { border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.zero { color: var(--line); text-align: center; }
  th.rt { text-align: left; font-weight: 600; color: var(--ink); }
  td.clamp2 { max-width: 280px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  table code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
  .matrix th, .matrix td { text-align: center; }
  .matrix th.rt { text-align: left; }

  /* Hand-rolled SVG diagrams (no graph-viz library). */
  .lineage-svg, .timeline-svg { width: 100%; height: auto; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; }
  .ln-node { fill: #ffffff; stroke: var(--line); }
  .ln-root { fill: #eef5f4; stroke: var(--accent); }
  .ln-text { font-size: 12px; fill: var(--ink); }
  .ln-edge { fill: none; stroke: var(--line); stroke-width: 1.5; }
  .tl-line { stroke: var(--muted); stroke-width: 2; }
  .tl-line.ho-pending { stroke: #9a6b16; }
  .tl-line.ho-returned { stroke: #1f7a47; }
  .tl-line.ho-consumed { stroke: #2c4fa6; }
  .tl-open { fill: var(--accent); }
  .tl-ret { fill: #ffffff; stroke: var(--accent); stroke-width: 1.5; }
  .tl-label { font-size: 11px; fill: var(--ink); }
`;

/**
 * Build the full observation page from the current pool contents. When `opts.live` is set (the
 * `bun run serve` viewer), the header gets a vanilla-JS Refresh button that reloads the page,
 * which re-renders it. The static `bun run render` output omits the button (pure HTML/CSS).
 */
export function renderHtml(db: Database, opts: { live?: boolean; only?: string } = {}): string {
  const concepts = loadConcepts(db);
  const lineage = loadLineage(db);
  const handoffs = loadHandoffs(db);
  const refreshButton = opts.live
    ? `<button type="button" class="refresh" onclick="location.reload()" title="Re-render from the pool">&#8635; Refresh</button>`
    : "";

  // Group by project so the shared pool's projects never commingle. The static render shows every
  // project; the live viewer can scope to one via ?project= (opts.only), with a switcher to the rest.
  const projects = groupByProject(concepts, lineage, handoffs);
  const shown = opts.only ? projects.filter((p) => p.id === opts.only) : projects;
  const projectIndex = renderProjectIndex(projects, opts);
  const overview = renderOverview(concepts, projects.length, lineage.length, handoffs.length);
  const schemaPanel = renderSchemaPanel(tableCounts(db));
  // Small pools stay open and scannable; large ones collapse to an index of project headers. A
  // project scoped via ?project= is always open.
  const isOpen = (p: ProjectBucket) => projects.length <= 3 || opts.only === p.id;
  const sections =
    shown.length > 0
      ? shown.map((p) => renderProjectSection(p, opts, isOpen(p))).join("")
      : `<p class="empty">Nothing in the pool yet.</p>`;

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
      <div class="head-row">
        <div>
          <h1>headwater</h1>
          <div class="tag">the handoff of state between AI surfaces, made observable</div>
        </div>
        ${refreshButton}
      </div>
    </header>
    <p class="generated">Generated ${fmtTime(nowIso())}</p>
    <div class="toolbar">
      ${overview}
      ${projectIndex}
    </div>
    ${schemaPanel}
    ${sections}
  </div>
</body>
</html>
`;
}

const DEFAULT_VIEW_PORT = 8765;

/** Handle a viewer request: re-render the page from the pool on every load. */
function handleViewerRequest(req: Request, db: Database): Response {
  const url = new URL(req.url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    // ?project=<id> scopes the page to one project (server-side; no client JS). Absent -> all projects.
    const only = url.searchParams.get("project") ?? undefined;
    return new Response(renderHtml(db, { live: true, only }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
}

/**
 * Start a tiny local viewer. Every request — and so every click of the page's Refresh button —
 * re-renders the page from the current pool. The live counterpart to `bun run render`.
 */
export function startViewer(
  port: number = Number(process.env.HEADWATER_VIEW_PORT ?? DEFAULT_VIEW_PORT),
) {
  const db = initDb();
  const server = Bun.serve({ port, fetch: (req) => handleViewerRequest(req, db) });
  console.error(
    `headwater viewer live at http://localhost:${server.port}  —  Refresh re-renders from the pool`,
  );
  return server;
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
  if (process.argv[2] === "serve") {
    startViewer();
  } else {
    await main();
  }
}
