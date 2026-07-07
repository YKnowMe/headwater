// render.ts — the observation page.
//
// `bun run render` reads the pool and writes a single static index.html (pure HTML/CSS from
// template literals — no client JS, no forms): concepts grouped by status, the lineage tree
// (parent -> branches), and the handoff timeline. This output is strictly read-only (only SELECTs).
//
// `bun run serve` starts a tiny local viewer (Bun.serve) that re-renders the same page from the
// pool on every request; in that live mode the page carries a vanilla-JS Refresh button
// (location.reload()) and native <form> write actions — comment (an `annotates` fork), fork, and
// open/return handoff — that POST to same-origin /w/* routes, call the existing server.ts tool
// functions, and 303-redirect (PRG). GET renders read-only; only POST writes, and only the live
// viewer carries forms. The server binds to 127.0.0.1 (unauthenticated localhost; see CLAUDE.md).
//
// Regenerate the file:  bun run render        Live view:  bun run serve

import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDb, nowIso, CONCEPT_STATUSES, CONCEPT_TYPES } from "./db.ts";
import type { ConceptRow, HandoffRow, LineageRow } from "./db.ts";
// The live viewer's write surface calls the SAME tool-logic functions the MCP tools use (no new write
// path, so every invariant — immutability, append-only lineage, frozen snapshots — holds). server.ts
// imports only ./db.ts, so this stays a clean render -> server -> db DAG (no cycle).
import { forkConcept, openHandoff, returnHandoff, computeClosures } from "./server.ts";
import type { ClosedBy } from "./server.ts";

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
// --- rich concept bodies: escape-first markdown subset + mermaid (the recorded carve-out) ----------
// SECURITY: esc() the text FIRST, then re-introduce ONLY a fixed whitelist of tags we construct
// ourselves. Every dynamic value (alt, link text, code, cell, heading, URL) comes from already-escaped
// text, so no raw "/'/</> survive — the page can never receive raw HTML/SVG from a concept body. URLs
// must start http(s):// (javascript:/data: are left as inert text, never an attribute).

/**
 * Resolve a [[wikilink]] slug to an in-page anchor id, or null when the pool has no such node.
 * Exact concept/handoff ids win; a concept id written without its hash suffix (the common way bodies
 * cite each other) resolves by prefix, earliest-created first, so links stay stable as the pool grows.
 */
type WikiResolve = (slug: string) => string | null;

type CurrentConcept = { id: string; title: string; status: string; body: string; created_at: string };

/**
 * Whole-pool context for cross-cutting rendering: wikilink resolution, the frozen-vs-current
 * comparison, and the drift verdict. Always built from the WHOLE pool (never the current live
 * filter), so a scoped view can neither fake a ghost nor hide real drift.
 */
type PoolCtx = {
  resolve: WikiResolve;
  /** Every concept's current row — the "current — in pool now" side of a carried-concept pane. */
  current: Map<string, CurrentConcept>;
  /** Lineage edges pointing AT a concept (its forks), for "diverged — N forks since handoff". */
  forksTo: Map<string, Array<{ from: string; at: string }>>;
  /** Derived closure per concept (see the pool decision) — drives effective grouping + the badge. */
  closures: Map<string, ClosedBy>;
};

function buildPoolCtx(db: Database): PoolCtx {
  const rows = db
    .query<CurrentConcept, []>(`SELECT id, title, status, body, created_at FROM concept ORDER BY created_at ASC`)
    .all();
  const current = new Map(rows.map((r) => [r.id, r] as const));
  const ids = rows.map((r) => r.id);
  const handoffIds = new Set(db.query<{ id: string }, []>(`SELECT id FROM handoff`).all().map((r) => r.id));
  const forksTo = new Map<string, Array<{ from: string; at: string }>>();
  const edges = db
    .query<{ from_concept_id: string; to_concept_id: string; created_at: string }, []>(
      `SELECT from_concept_id, to_concept_id, created_at FROM lineage ORDER BY created_at ASC`,
    )
    .all();
  for (const e of edges) {
    const list = forksTo.get(e.to_concept_id) ?? [];
    list.push({ from: e.from_concept_id, at: e.created_at });
    forksTo.set(e.to_concept_id, list);
  }
  const resolve: WikiResolve = (slug) => {
    if (current.has(slug) || handoffIds.has(slug)) return slug;
    return ids.find((id) => id.startsWith(slug + "-")) ?? null;
  };
  return { resolve, current, forksTo, closures: computeClosures(db) };
}

/** Effective status: derived closure moves a still-open stored status into `resolved`. */
function effectiveStatus(c: ConceptView, ctx: PoolCtx): string {
  return ctx.closures.has(c.id) && c.status !== "discarded" && c.status !== "resolved" ? "resolved" : c.status;
}

/** Inline formatting on one line. Escapes first; nothing below can introduce a raw `<` or `"`. */
function inline(raw: string, resolve?: WikiResolve): string {
  let s = esc(raw);
  // [[wikilinks]] first (slug charset only — already-escaped text can't smuggle quotes into href).
  // Resolved -> anchor link to the node's card; dangling -> the ghost grammar (dashed, tooltip).
  if (resolve) {
    s = s.replace(/\[\[([A-Za-z0-9][A-Za-z0-9_-]*)\]\]/g, (_m, slug) => {
      const target = resolve(slug);
      return target
        ? `<a class="wl" href="#${target}">[[${slug}]]</a>`
        : `<span class="wl-ghost" title="referenced concept id not present in the pool">[[${slug}]]</span>`;
    });
  }
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, alt, url) => `<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, text, url) => `<a href="${url}" rel="noopener noreferrer" target="_blank">${text}</a>`);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<b>${t}</b>`);
  s = s.replace(/\*([^*\s][^*]*)\*/g, (_m, t) => `<i>${t}</i>`);
  return s;
}

function splitCells(row: string): string[] {
  return row.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "").split("|").map((c) => c.trim());
}

function renderMdTable(header: string[], rows: string[][], resolve?: WikiResolve): string {
  const th = header.map((c) => `<th>${inline(c, resolve)}</th>`).join("");
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, resolve)}</td>`).join("")}</tr>`).join("");
  return `<table class="md"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// Checklist markdown before plain bullets — a task line is also a bullet line, so order matters.
const TASK_ITEM = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET_ITEM = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Render a concept body: images (http(s) only), http links, bold/italic/code, headings, pipe-tables,
 * and fenced blocks. A ```mermaid block becomes a live <pre class="mermaid"> (rendered client-side by
 * the vendored strict Mermaid) when `live`, else a static code block. See the CLAUDE.md carve-out.
 */
function renderRichBody(body: string, live: boolean, resolve?: WikiResolve): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const lang = fence[1]!.toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "```") { buf.push(lines[i]!); i++; }
      i++; // skip closing fence
      const src = esc(buf.join("\n"));
      out.push(lang === "mermaid" && live ? `<pre class="mermaid">${src}</pre>` : `<pre class="code-block">${src}</pre>`);
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && next.includes("|") && /^[\s|:-]*-[\s|:-]*$/.test(next)) {
      const header = splitCells(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") { rows.push(splitCells(lines[i]!)); i++; }
      out.push(renderMdTable(header, rows, resolve));
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) { out.push(`<h4 class="md-h">${inline(hm[2]!, resolve)}</h4>`); i++; continue; }
    // List run: consume consecutive list lines, then emit one list element per same-flavor segment.
    // Checklist items become the task grammar (registry concepts — see the Design pass); flat only,
    // no nesting — that stays outside the subset.
    if (TASK_ITEM.test(line) || ORDERED_ITEM.test(line) || BULLET_ITEM.test(line)) {
      const items: Array<{ flavor: "task" | "ul" | "ol"; html: string }> = [];
      while (i < lines.length) {
        const l = lines[i]!;
        let m: RegExpExecArray | null;
        if ((m = TASK_ITEM.exec(l))) {
          const done = m[1] !== " " ? ' class="done"' : "";
          items.push({ flavor: "task", html: `<li${done}><span class="task-text">${inline(m[2]!, resolve)}</span></li>` });
        } else if ((m = ORDERED_ITEM.exec(l))) {
          items.push({ flavor: "ol", html: `<li>${inline(m[1]!, resolve)}</li>` });
        } else if ((m = BULLET_ITEM.exec(l))) {
          items.push({ flavor: "ul", html: `<li>${inline(m[1]!, resolve)}</li>` });
        } else break;
        i++;
      }
      let j = 0;
      while (j < items.length) {
        const flavor = items[j]!.flavor;
        const seg: string[] = [];
        while (j < items.length && items[j]!.flavor === flavor) { seg.push(items[j]!.html); j++; }
        const lis = seg.join("");
        out.push(flavor === "ol" ? `<ol>${lis}</ol>` : flavor === "task" ? `<ul class="tasks">${lis}</ul>` : `<ul>${lis}</ul>`);
      }
      continue;
    }
    out.push(inline(line, resolve));
    i++;
  }
  return out.join("\n");
}

const BODY_CLAMP = 280;
function renderBody(body: string, live: boolean, resolve?: WikiResolve): string {
  const rich = renderRichBody(body, live, resolve);
  if (body.length <= BODY_CLAMP) return `<div class="card-body">${rich}</div>`;
  return `<details class="card-body"><summary class="body-summary">${esc(flatPreview(body))}</summary><div class="body-full">${rich}</div></details>`;
}

// --- data access ------------------------------------------------------------

// Live-only concept filters (the static render passes none). q is a plain SQL LIKE substring — NOT
// FTS, no ranking, no highlight — so it stays inside the scope fence. type/status are validated against
// the enums in handleViewerRequest before reaching here; all binds are parameterized.
type Filters = { type?: string; status?: string; surface?: string; q?: string };

function loadConcepts(db: Database, f: Filters = {}): ConceptView[] {
  return db
    .query<ConceptView, any>(
      `SELECT c.*, s.label AS origin_label, p.name AS project_name
         FROM concept c
         JOIN surface s ON s.id = c.origin_surface_id
         JOIN project p ON p.id = c.project_id
        WHERE ($type IS NULL OR c.type = $type)
          AND ($status IS NULL OR c.status = $status)
          AND ($surface IS NULL OR c.origin_surface_id = $surface OR s.label = $surface)
          AND ($qlike IS NULL OR c.title LIKE $qlike OR c.body LIKE $qlike)
        ORDER BY c.created_at ASC`,
    )
    .all({
      $type: f.type ?? null,
      $status: f.status ?? null,
      $surface: f.surface ?? null,
      $qlike: f.q ? `%${f.q}%` : null,
    });
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

/**
 * Live-viewer write actions for one concept, tucked behind a collapsed disclosure so the read-first
 * page stays clean. Comment is an `annotates` fork and Fork is a `forks_from` fork — both create a NEW
 * immutable node + lineage edge (never an UPDATE). Hand off opens a pending handoff carrying this
 * concept. Every dynamic value is esc()'d; all posts go to same-origin /w/* routes. Live viewer only.
 */
function renderCardActions(c: ConceptView): string {
  const pid = esc(c.id);
  const proj = esc(c.project_id);
  const typeOpts = CONCEPT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
  return `
    <details class="actions">
      <summary>Act on this concept</summary>
      <form class="wform" method="post" action="/w/comment">
        <label>Comment <span class="hint">annotates — a fork, never an edit</span></label>
        <input type="hidden" name="parent_id" value="${pid}" />
        <textarea name="body" rows="2" required placeholder="your annotation"></textarea>
        <button type="submit">Comment</button>
      </form>
      <form class="wform" method="post" action="/w/fork">
        <label>Fork <span class="hint">a new branch off this concept</span></label>
        <input type="hidden" name="parent_id" value="${pid}" />
        <input type="text" name="title" placeholder="title (optional — defaults to parent's)" />
        <select name="type">${typeOpts}</select>
        <textarea name="body" rows="2" required placeholder="the forked concept body"></textarea>
        <button type="submit">Fork</button>
      </form>
      <form class="wform" method="post" action="/w/handoff/open">
        <label>Hand off <span class="hint">carry this concept to another surface</span></label>
        <input type="hidden" name="project" value="${proj}" />
        <input type="hidden" name="concept_ids" value="${pid}" />
        <input type="hidden" name="from_surface" value="operator" />
        <input type="text" name="to_surface" placeholder="to surface (e.g. claude-code)" required />
        <textarea name="directive" rows="2" required placeholder="directive — what should the receiver do?"></textarea>
        <button type="submit">Open handoff</button>
      </form>
    </details>`;
}

function renderConceptCard(c: ConceptView, live: boolean, ctx: PoolCtx): string {
  // Derived closure: badge the closing fork so "why is this under resolved?" answers itself.
  const cb = ctx.closures.get(c.id);
  const closedBy = cb
    ? `<span class="closed-by">${cb.via === "supersedes" ? "superseded" : "resolved"} by <a class="wl" href="#${esc(cb.concept_id)}"><code class="id">${esc(cb.concept_id)}</code></a></span>`
    : "";
  // The card's id is the concept id — the anchor every resolved [[wikilink]] points at.
  return `
    <article class="card" id="${esc(c.id)}">
      <div class="card-head">
        ${badge(c.type, "type")}
        <h3 class="card-title">${esc(c.title)}</h3>
        ${closedBy}
      </div>
      ${renderBody(c.body, live, ctx.resolve)}
      <div class="meta">
        <code class="id">${esc(c.id)}</code>
        <span>origin: ${esc(c.origin_label)}</span>
        <span>project: ${esc(c.project_name)}</span>
        <span>${fmtTime(c.created_at)}</span>
      </div>
      ${live ? renderCardActions(c) : ""}
    </article>`;
}

// Cap how many cards a single status group renders inline; the rest tuck behind a CSS-only "show
// more" disclosure so a 200-concept group can't blow out the page (every card stays one click away).
const CARD_CAP = 12;

function renderCards(items: ConceptView[], live: boolean, ctx: PoolCtx): string {
  const cards = items.map((c) => renderConceptCard(c, live, ctx));
  if (cards.length <= CARD_CAP) return `<div class="cards">${cards.join("")}</div>`;
  const head = cards.slice(0, CARD_CAP).join("");
  const rest = cards.slice(CARD_CAP).join("");
  return `<div class="cards">${head}</div><details class="more"><summary>Show ${cards.length - CARD_CAP} more</summary><div class="cards">${rest}</div></details>`;
}

function renderConceptsSection(concepts: ConceptView[], live: boolean, ctx: PoolCtx): string {
  if (concepts.length === 0) {
    return `<section><h2>Concepts</h2><p class="empty">No concepts yet.</p></section>`;
  }
  // Grouped by EFFECTIVE status: derived-closed concepts sit under resolved, badged with their closer.
  const groups = CONCEPT_STATUSES.map((status) => {
    const items = concepts.filter((c) => effectiveStatus(c, ctx) === status);
    if (items.length === 0) return "";
    return `
      <div class="status-group">
        <h3 class="status-head">${badge(status, `st-${status}`)} <span class="count">${items.length}</span></h3>
        ${renderCards(items, live, ctx)}
      </div>`;
  }).join("");
  return `<section><h2>Concepts <span class="count">${concepts.length}</span></h2>${groups}</section>`;
}

/** Sticky toolbar content: pool scale + per-status tallies (effective status, matching the groups). */
function renderOverview(concepts: ConceptView[], projectCount: number, lineageCount: number, handoffCount: number, ctx: PoolCtx): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const tallies = CONCEPT_STATUSES.map((s) => [s, concepts.filter((c) => effectiveStatus(c, ctx) === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${badge(s, `st-${s}`)} <span class="count">${n}</span>`)
    .join(" ");
  return `<div class="overview">
      <span class="scale">${plural(projectCount, "project")} · ${plural(concepts.length, "concept")} · ${plural(lineageCount, "lineage edge")} · ${plural(handoffCount, "handoff")}</span>
      <span class="tallies">${tallies}</span>
    </div>`;
}

/**
 * The ONE canonical lineage tree (diagram/table representations pruned — the settled Design pass).
 * A fork edge needs no reveal: its whole evidence (kind + reason badges) fits inline on the branch
 * row. Open loops get the ghost grammar: a pending handoff hangs a `carried by` edge plus a dashed
 * "expected return concept" branch off each carried concept, and a root whose body cites a concept
 * the pool doesn't have grows a dashed "dangling link" branch.
 */
function renderLineageSection(edges: LineageView[], handoffs: HandoffView[], ctx: PoolCtx): string {
  // Group edges by parent (to_concept_id): the original is the canonical root, branches hang off it.
  const parents = new Map<string, { title: string; branches: LineageView[] }>();
  for (const e of edges) {
    const entry = parents.get(e.to_concept_id) ?? { title: e.parent_title, branches: [] };
    entry.branches.push(e);
    parents.set(e.to_concept_id, entry);
  }
  // A pending handoff's carried concepts join the forest even with no forks yet — the open loop
  // must have a visible shape (decision 4).
  const pendingBy = new Map<string, HandoffView[]>();
  for (const h of handoffs) {
    if (h.status !== "pending") continue;
    for (const f of parseSnapshot(h.payload_snapshot)) {
      if (!parents.has(f.id)) parents.set(f.id, { title: ctx.current.get(f.id)?.title ?? f.title, branches: [] });
      const list = pendingBy.get(f.id) ?? [];
      list.push(h);
      pendingBy.set(f.id, list);
    }
  }
  if (parents.size === 0) {
    return `<section><h2>Lineage</h2><p class="empty">No lineage edges yet.</p></section>`;
  }
  const trees = [...parents.entries()]
    .map(([parentId, { title, branches }]) => {
      const rows = branches.map(
        (b) => `
          <li class="branch">
            <span class="branch-edge">${badge(b.kind, "edge")}${
              b.reason ? badge(b.reason, "reason") : ""
            }</span>
            <span class="branch-node">${esc(b.child_title)} <code class="id">${esc(b.from_concept_id)}</code></span>
          </li>`,
      );
      for (const h of pendingBy.get(parentId) ?? []) {
        rows.push(`
          <li class="branch ho-edge">
            ${badge(`handoff · ${h.status}`, `ho-${h.status}`)}
            <span class="branch-node">carried by</span> <code class="id">${esc(h.id)}</code>
            <span class="annot">&rarr; ${esc(h.to_label)}</span>
          </li>`);
        rows.push(`
          <li class="branch ghost-branch">
            ${badge("expected", "ghost-badge")}
            <span class="ghost-node">return concept from <code>${esc(h.to_label)}</code> — not yet in pool</span>
          </li>`);
      }
      const rootBody = ctx.current.get(parentId)?.body ?? "";
      const seen = new Set<string>();
      for (const m of rootBody.matchAll(/\[\[([A-Za-z0-9][A-Za-z0-9_-]*)\]\]/g)) {
        const slug = m[1]!;
        if (seen.has(slug) || ctx.resolve(slug)) continue;
        seen.add(slug);
        rows.push(`
          <li class="branch ghost-branch">
            ${badge("dangling link", "ghost-badge")}
            <span class="ghost-node">body references <code>[[${esc(slug)}]]</code> — no such concept in the pool</span>
          </li>`);
      }
      return `
        <div class="tree">
          <div class="tree-root">${esc(title)} <code class="id">${esc(parentId)}</code></div>
          <ul class="branches">${rows.join("")}</ul>
        </div>`;
    })
    .join("");
  return `<section><h2>Lineage <span class="count">${edges.length}</span></h2>${trees}</section>`;
}

type FrozenConcept = { id: string; title: string; status: string; body: string; created_at: string };

/** The frozen payload of a handoff — parsed defensively; malformed JSON renders as "carries 0". */
function parseSnapshot(payload: string): FrozenConcept[] {
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One carried concept inside a handoff's evidence: frozen pane (as handed off) beside the current
 * pane (in pool now), then a one-line drift verdict. Concepts are immutable, so divergence is
 * status transitions and forks since the handoff — both computable from the pool with plain SELECTs.
 */
function renderCarry(frozen: FrozenConcept, h: HandoffView, ctx: PoolCtx): string {
  const cur = ctx.current.get(frozen.id);
  const paneText = (b: string) => esc(clip(flatPreview(b), 240));
  const currentPane = cur
    ? `<div class="pane current"><div class="pane-h"><span>current — in pool now</span>${badge(cur.status, `st-${cur.status}`)}</div><p>${paneText(cur.body)}</p></div>`
    : `<div class="pane current"><div class="pane-h"><span>current — in pool now</span></div><p>not in the pool</p></div>`;
  const moved: string[] = [];
  if (cur && cur.status !== frozen.status) moved.push(`status ${esc(frozen.status)} &rarr; ${esc(cur.status)}`);
  const forks = (ctx.forksTo.get(frozen.id) ?? []).filter((f) => f.at >= h.initiated_at);
  if (forks.length > 0) {
    const ids = forks.map((f) => `<code class="id">${esc(f.from)}</code>`).join(" ");
    moved.push(`${forks.length} fork${forks.length === 1 ? "" : "s"} since handoff: ${ids}`);
  }
  const drift = moved.length
    ? `<span class="drift moved">diverged — ${moved.join("; ")}</span>`
    : `<span class="drift same">unchanged since handoff</span>`;
  return `
        <div class="carry">
          <p class="carry-title">${esc(frozen.title)} <code class="id">${esc(frozen.id)}</code></p>
          <div class="compare">
            <div class="pane frozen"><div class="pane-h"><span>frozen — as handed off</span><span>${esc(h.initiated_at.slice(0, 10))}</span></div><p>${paneText(frozen.body)}</p></div>
            ${currentPane}
          </div>
          ${drift}
        </div>`;
}

/**
 * One handoff on the canonical spine timeline: opened dot -> status-colored spine -> terminus
 * (returned dot, or the dashed ghost of a surface that hasn't written back). ALL its evidence —
 * per-carried-concept frozen/current comparison and the return note — lives behind ONE native
 * <details class="evidence"> (the settled reveal affordance; no pane, no popover, no JS). A pending
 * handoff's evidence starts open: the open loop is the thing the page exists to make visible.
 */
function renderHandoffEntry(h: HandoffView, live: boolean, ctx: PoolCtx): string {
  const frozen = parseSnapshot(h.payload_snapshot);
  const n = frozen.length;
  const pending = h.status === "pending";
  const carries = frozen.map((f) => renderCarry(f, h, ctx)).join("");
  const closing = pending
    ? `<div class="no-return">no return note yet — the loop is open</div>`
    : `<div class="return-note"><p class="ev-h">return note · ${esc(fmtTime(h.returned_at))}</p>${esc(h.return_note ?? "")}</div>`;
  // Live viewer only: a pending handoff can be closed in place — returnHandoff moves status/return_note
  // while the frozen directive + payload_snapshot stay untouched (the anti-distortion invariant).
  const returnForm =
    live && pending
      ? `
        <form class="wform" method="post" action="/w/handoff/return">
          <label>Return <span class="hint">close the loop — what came back?</span></label>
          <input type="hidden" name="handoff_id" value="${esc(h.id)}" />
          <textarea name="return_note" rows="2" required placeholder="return note"></textarea>
          <button type="submit">Return handoff</button>
        </form>`
      : "";
  const terminus = pending
    ? `<div class="terminus ghost"><span class="who">${esc(h.to_label)}</span> has not written back — awaiting return</div>`
    : `<div class="terminus ret"><span class="who">${esc(h.to_label)}</span> returned · ${esc(fmtTime(h.returned_at))}</div>`;
  return `
      <li class="ho is-${esc(h.status)}" id="${esc(h.id)}">
        <div class="ho-row">
          <span class="route">${esc(h.from_label)} <span class="arrow">&rarr;</span> ${esc(h.to_label)}</span>
          ${badge(h.status, `ho-${h.status}`)}
          <span class="when">opened ${fmtTime(h.initiated_at)}</span>
        </div>
        <div class="ho-body">
          <p class="directive">${inline(h.directive, ctx.resolve)}</p>
          <div class="ho-meta"><code class="id">${esc(h.id)}</code><span>carries ${n} concept${n === 1 ? "" : "s"}</span></div>
          <details class="evidence"${pending ? " open" : ""}>
            <summary>evidence — payload, carried concept${n === 1 ? "" : "s"}, ${pending ? "no return yet" : "return note"}</summary>
            <div class="ev-body">${carries}${closing}</div>
          </details>
          ${returnForm}
        </div>
        ${terminus}
      </li>`;
}

/** The ONE canonical handoff timeline (cards/table/SVG representations pruned — the settled Design pass). */
function renderHandoffsSection(handoffs: HandoffView[], live: boolean, ctx: PoolCtx): string {
  if (handoffs.length === 0) {
    return `<section><h2>Handoffs</h2><p class="empty">No handoffs yet.</p></section>`;
  }
  const entries = handoffs.map((h) => renderHandoffEntry(h, live, ctx)).join("");
  return `<section><h2>Handoffs <span class="count">${handoffs.length}</span></h2><ul class="timeline">${entries}</ul></section>`;
}

// --- Phase 2 leftovers: the type x status matrix and the schema panel (kept — not representations) --

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
function renderProjectSection(p: ProjectBucket, opts: { live?: boolean }, open: boolean, ctx: PoolCtx): string {
  const counts = `${p.concepts.length}c · ${p.edges.length}l · ${p.handoffs.length}h`;
  const focus = opts.live ? ` <a class="focus" href="/?project=${encodeURIComponent(p.id)}">focus</a>` : "";
  return `
    <details class="project" id="proj-${esc(p.id)}"${open ? " open" : ""}>
      <summary><span class="proj-name">${esc(p.name)}</span> <span class="count">${counts}</span>${focus}</summary>
      ${renderConceptsSection(p.concepts, !!opts.live, ctx)}
      ${renderMatrix(p.concepts)}
      ${renderLineageSection(p.edges, p.handoffs, ctx)}
      ${renderHandoffsSection(p.handoffs, !!opts.live, ctx)}
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

// --- Phase 3: live-only faceted filters + plain-LIKE search (server-side, no client JS) ------------

type ViewOpts = { live?: boolean; only?: string; filters?: Filters };

function distinctSurfaces(db: Database): string[] {
  return db
    .query<{ label: string }, []>(
      `SELECT DISTINCT s.label AS label FROM concept c JOIN surface s ON s.id = c.origin_surface_id ORDER BY label`,
    )
    .all()
    .map((r) => r.label);
}

/** Build a "/" URL preserving the current project + filters, applying one set/clear change. */
function filterHref(opts: ViewOpts, change: Record<string, string | null>): string {
  const f = opts.filters ?? {};
  const p = new URLSearchParams();
  if (opts.only) p.set("project", opts.only);
  if (f.type) p.set("type", f.type);
  if (f.status) p.set("status", f.status);
  if (f.surface) p.set("surface", f.surface);
  if (f.q) p.set("q", f.q);
  for (const [k, v] of Object.entries(change)) {
    if (v == null) p.delete(k);
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

/** Faceted chips (type/status/surface) + a GET search box — all live-only, all read-only navigation. */
function renderFilterBar(db: Database, opts: ViewOpts): string {
  const f = opts.filters ?? {};
  const chip = (label: string, dim: "type" | "status" | "surface", val: string): string => {
    const active = f[dim] === val;
    const href = esc(filterHref(opts, { [dim]: active ? null : val }));
    return `<a class="fchip${active ? " active" : ""}" href="${href}">${esc(label)}</a>`;
  };
  const types = CONCEPT_TYPES.map((t) => chip(t, "type", t)).join("");
  const statuses = CONCEPT_STATUSES.map((s) => chip(s, "status", s)).join("");
  const surfaces = distinctSurfaces(db).map((s) => chip(s, "surface", s)).join("");
  const anyActive = f.type || f.status || f.surface || f.q;
  const clear = anyActive ? `<a class="fchip clear" href="${esc(filterHref(opts, { type: null, status: null, surface: null, q: null }))}">clear</a>` : "";
  const hidden = (["project", "type", "status", "surface"] as const)
    .map((k) => {
      const v = k === "project" ? opts.only : f[k as "type" | "status" | "surface"];
      return v ? `<input type="hidden" name="${k}" value="${esc(v)}" />` : "";
    })
    .join("");
  const search = `<form class="search" method="get" action="/"><input type="text" name="q" value="${esc(f.q ?? "")}" placeholder="search title / body" />${hidden}</form>`;
  return `<nav class="filter-bar">
      <span class="flabel">type</span>${types}
      <span class="flabel">status</span>${statuses}
      ${surfaces ? `<span class="flabel">surface</span>${surfaces}` : ""}
      ${search}${clear}
    </nav>`;
}

const STYLE = `
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1c2330; --muted: #6b7385;
    --line: #e4e7ec; --accent: #2f6f6a;
    --pending: #9a6b16; --pending-bg: #fbf0dc;
    --returned: #1f7a47; --returned-bg: #e2f3e8;
    --ghost: #8b93a5;
    --frozen-bg: #f0f4f8; --frozen-line: #c9d4e0; --frozen-ink: #44506b;
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
  .card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .closed-by { font-size: 12.5px; color: var(--returned); margin-left: auto; }
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
  /* The ONE canonical tree. Ghost grammar: dashed + italic + hollow = expected-but-not-present. */
  .tree { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 12px; }
  .tree-root { font-weight: 600; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .branches { list-style: none; margin: 10px 0 0; padding: 0 0 0 6px; }
  .branch { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding: 6px 0 6px 14px;
    border-left: 2px solid var(--line); margin-left: 4px; }
  .branch-node { color: #333a48; }
  .branch.ho-edge { border-left-color: color-mix(in oklab, var(--pending) 55%, var(--line)); }
  .branch.ghost-branch { border-left-style: dashed; border-left-color: var(--ghost); }
  .ghost-node { color: var(--ghost); font-style: italic;
    border: 1px dashed var(--ghost); border-radius: 8px; padding: 2px 10px; }
  .ghost-node code { font-style: normal; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; color: var(--ghost); }
  .badge.ghost-badge { background: transparent; border: 1px dashed var(--ghost); color: var(--ghost); }
  .annot { color: var(--muted); font-size: 12.5px; }

  /* The ONE canonical handoff timeline: opened dot -> status-colored spine -> terminus. */
  .timeline { list-style: none; margin: 0; padding: 0; }
  .ho { position: relative; padding: 0 0 8px 34px; }
  .ho::before { content: ""; position: absolute; left: 9px; top: 26px; bottom: -2px;
    width: 2px; background: var(--line); }
  .ho.is-pending::before { background: none;
    border-left: 2px dashed color-mix(in oklab, var(--pending) 55%, var(--line)); }
  .ho::after { content: ""; position: absolute; left: 4px; top: 12px; width: 8px; height: 8px;
    border-radius: 50%; background: var(--accent); border: 2px solid var(--accent); }
  .ho.is-pending::after { background: var(--pending-bg); border-color: var(--pending); }
  .ho-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; padding: 6px 0 2px; }
  .route { font-weight: 650; }
  .route .arrow { color: var(--accent); padding: 0 3px; }
  .ho-row .when { color: var(--muted); font-size: 12.5px; }
  .ho-body { max-width: 65ch; }
  .directive { margin: 4px 0 8px; color: #333a48; }
  .ho-meta { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 12.5px;
    align-items: center; margin-bottom: 6px; }
  .terminus { position: relative; margin: 2px 0 22px; padding: 4px 0 0 34px; font-size: 13.5px; }
  .terminus::after { content: ""; position: absolute; left: 4px; top: 9px; width: 8px; height: 8px;
    border-radius: 50%; }
  .terminus.ret { color: var(--returned); }
  .terminus.ret::after { background: #fff; border: 2px solid var(--returned); }
  .terminus.ghost { color: var(--ghost); font-style: italic; }
  .terminus.ghost::after { background: transparent; border: 2px dashed var(--ghost); }
  .terminus .who { font-style: normal; font-weight: 600; }

  /* Evidence disclosure — the single reveal affordance (native details, no JS). */
  details.evidence { margin: 2px 0 4px; }
  details.evidence > summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center;
    gap: 8px; color: var(--accent); font-size: 13px; font-weight: 600; padding: 4px 10px 4px 8px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  details.evidence > summary:hover { border-color: var(--accent); }
  details.evidence > summary::-webkit-details-marker { display: none; }
  details.evidence > summary::before { content: "\\25B8"; color: var(--muted); }
  details.evidence[open] > summary::before { content: "\\25BE"; }
  .ev-body { border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
    margin: 8px 0 4px; padding: 14px 16px; }
  .ev-h { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 8px; }

  /* Frozen vs current, per carried concept — the anti-distortion property made legible. */
  .carry { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
  .carry:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
  .carry-title { font-size: 14px; font-weight: 650; margin: 0 0 8px; display: flex; flex-wrap: wrap;
    gap: 8px; align-items: baseline; }
  .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 720px) { .compare { grid-template-columns: 1fr; } }
  .pane { border-radius: 8px; padding: 10px 12px; font-size: 13.5px; }
  .pane .pane-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; margin-bottom: 6px; }
  .pane p { margin: 0; color: #333a48; }
  .pane.frozen { background: var(--frozen-bg); border: 1px solid var(--frozen-line); }
  .pane.frozen .pane-h { color: var(--frozen-ink); }
  .pane.frozen p { color: var(--frozen-ink); }
  .pane.current { background: #fff; border: 1px solid var(--line); border-left: 3px solid var(--accent); }
  .pane.current .pane-h { color: var(--accent); }
  .drift { font-size: 12.5px; margin: 8px 0 0; padding: 5px 10px; border-radius: 6px; display: inline-block; }
  .drift.same { background: var(--returned-bg); color: var(--returned); }
  .drift.moved { background: var(--pending-bg); color: var(--pending); }
  .return-note { margin: 12px 0 0; padding: 10px 12px; background: #f3f6f5; border-radius: 8px;
    font-size: 13.5px; border-left: 3px solid var(--returned); }
  .return-note .ev-h { color: var(--returned); margin-bottom: 4px; }
  .no-return { margin: 12px 0 0; padding: 10px 12px; border: 1px dashed var(--ghost); border-radius: 8px;
    color: var(--ghost); font-size: 13.5px; font-style: italic; }
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

  /* Live-only filter bar: faceted chips + a GET search box (read-only navigation, no client JS). */
  .filter-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0 0; }
  .flabel { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-left: 8px; }
  .flabel:first-child { margin-left: 0; }
  .fchip { font-size: 12px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 999px;
    background: var(--panel); color: var(--ink); text-decoration: none; }
  .fchip:hover { border-color: var(--accent); }
  .fchip.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .fchip.clear { color: var(--muted); }
  .filter-bar .search { display: inline-flex; margin-left: auto; }
  .filter-bar .search input { font: inherit; font-size: 12.5px; padding: 3px 11px;
    border: 1px solid var(--line); border-radius: 999px; min-width: 170px; }
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

  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0 2px; }
  thead th { position: sticky; top: 0; background: var(--panel); text-align: left;
    font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted);
    border-bottom: 1px solid var(--line); padding: 6px 8px; }
  tbody td, tbody th { border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.zero { color: var(--line); text-align: center; }
  th.rt { text-align: left; font-weight: 600; color: var(--ink); }
  table code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
  .matrix th, .matrix td { text-align: center; }
  .matrix th.rt { text-align: left; }

  /* Rich concept bodies: escape-first markdown subset + mermaid (the carve-out). */
  /* lists inside concept bodies (white-space: normal — the pre-wrap parent must not add breaks) */
  .card-body ul, .card-body ol, .body-full ul, .body-full ol { margin: 6px 0; padding-left: 22px; white-space: normal; }
  .card-body li, .body-full li { margin: 3px 0; }
  /* task list — checklist markdown as checkboxes; registries are concepts kept current by supersede-forks */
  ul.tasks { list-style: none; padding-left: 4px; }
  ul.tasks li { display: flex; gap: 9px; align-items: baseline; margin: 5px 0; }
  ul.tasks li::before { content: ""; flex: 0 0 auto; width: 13px; height: 13px; border-radius: 4px;
    border: 1.5px solid var(--muted); background: #fff; transform: translateY(2px); }
  ul.tasks li.done::before { content: "\\2713"; background: #1f7a47; border-color: #1f7a47; color: #fff;
    font-size: 10px; line-height: 13px; text-align: center; }
  ul.tasks li.done { color: var(--muted); }
  ul.tasks li.done .task-text { text-decoration: line-through; text-decoration-color: #b9c0cc; }
  /* wikilinks: resolved -> accent anchor; dangling -> the ghost grammar (dashed = expected-but-not-present) */
  a.wl { color: var(--accent); text-decoration-thickness: 1px; }
  .wl-ghost { color: #8b93a5; border-bottom: 1px dashed #8b93a5; cursor: help; }
  .wl-ghost::after { content: " ?"; font-size: 11px; vertical-align: super; font-weight: 700; }
  .card-body img, .body-full img { max-width: 100%; height: auto; display: block;
    border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  .card-body a, .body-full a { color: var(--accent); }
  .card-body code, .body-full code, td code, th code { background: #eef1f4; padding: 1px 5px;
    border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  h4.md-h { font-size: 14px; margin: 12px 0 4px; }
  table.md { margin: 8px 0; }
  pre.mermaid { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px; margin: 8px 0; overflow: auto; }
  pre.code-block { background: #0f172a; color: #e2e8f0; padding: 10px 12px; border-radius: 8px;
    margin: 8px 0; overflow: auto; white-space: pre;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }

  /* Live-viewer write actions: collapsed per concept/handoff so the read-first page stays calm.
     Native form POSTs to /w/* -> server.ts -> 303 PRG. Live viewer only; the static file has no forms. */
  details.actions { margin: 10px 0 0; border-top: 1px solid var(--line); padding-top: 8px; }
  details.actions > summary { cursor: pointer; list-style: none; color: var(--accent);
    font-size: 12.5px; font-weight: 600; padding: 4px 0; }
  details.actions > summary::-webkit-details-marker { display: none; }
  details.actions > summary::before { content: "\\25B8  "; color: var(--muted); }
  details.actions[open] > summary::before { content: "\\25BE  "; }
  .wform { display: grid; gap: 6px; margin: 10px 0; padding: 10px 12px;
    background: #fafbfc; border: 1px solid var(--line); border-radius: 8px; }
  .wform label { font-size: 12.5px; font-weight: 600; color: var(--ink); }
  .wform .hint { font-weight: 400; color: var(--muted); font-size: 11.5px; }
  .wform input, .wform textarea, .wform select { font: inherit; font-size: 13px;
    padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; width: 100%; }
  .wform textarea { resize: vertical; min-height: 38px; }
  .wform button { justify-self: start; cursor: pointer; border: 1px solid var(--accent);
    background: var(--accent); color: #fff; font: inherit; font-size: 12.5px; font-weight: 600;
    padding: 6px 14px; border-radius: 7px; }
  .wform button:hover { background: #245751; border-color: #245751; }
`;

/**
 * Build the full observation page from the current pool contents. When `opts.live` is set (the
 * `bun run serve` viewer), the header gets a vanilla-JS Refresh button that reloads the page,
 * which re-renders it. The static `bun run render` output omits the button (pure HTML/CSS).
 */
export function renderHtml(db: Database, opts: ViewOpts = {}): string {
  const concepts = loadConcepts(db, opts.filters ?? {});
  const lineage = loadLineage(db);
  const handoffs = loadHandoffs(db);
  const refreshButton = opts.live
    ? `<button type="button" class="refresh" onclick="location.reload()" title="Re-render from the pool">&#8635; Refresh</button>`
    : "";
  // Live viewer only: load the vendored Mermaid and render ```mermaid blocks with securityLevel strict.
  // The static file carries no script (it shows mermaid source as a code block). See the CLAUDE.md carve-out.
  const mermaidScript = opts.live
    ? `\n  <script src="/vendor/mermaid.min.js"></script>\n  <script>mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" }); mermaid.run({ querySelector: ".mermaid" });</script>`
    : "";

  // Group by project so the shared pool's projects never commingle. The static render shows every
  // project; the live viewer can scope to one via ?project= (opts.only), with a switcher to the rest.
  const ctx = buildPoolCtx(db);
  const projects = groupByProject(concepts, lineage, handoffs);
  const shown = opts.only ? projects.filter((p) => p.id === opts.only) : projects;
  const projectIndex = renderProjectIndex(projects, opts);
  const filterBar = opts.live ? renderFilterBar(db, opts) : "";
  const overview = renderOverview(concepts, projects.length, lineage.length, handoffs.length, ctx);
  const schemaPanel = renderSchemaPanel(tableCounts(db));
  // Small pools stay open and scannable; large ones collapse to an index of project headers. A
  // project scoped via ?project= is always open.
  const isOpen = (p: ProjectBucket) => projects.length <= 3 || opts.only === p.id;
  const sections =
    shown.length > 0
      ? shown.map((p) => renderProjectSection(p, opts, isOpen(p), ctx)).join("")
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
      ${filterBar}
    </div>
    ${schemaPanel}
    ${sections}
  </div>${mermaidScript}
</body>
</html>
`;
}

const DEFAULT_VIEW_PORT = 8765;

// Operator-originated writes from the viewer are attributed to a single fixed surface. (Per the v1
// simplification, an upserted surface gets kind "external_agent"; per-connection identity comes later.)
const OPERATOR_SURFACE = "operator";

function redirect(location: string): Response {
  // 303 See Other: the browser re-GETs `location`, so a refresh never re-submits the write (PRG).
  return new Response(null, { status: 303, headers: { location } });
}

/**
 * Apply a write from a same-origin form POST, then 303-redirect back to the page (PRG). Every action
 * routes to an existing server.ts function, so the pool invariants are enforced in one place: a comment
 * is an `annotates` fork (never an UPDATE), a fork is `forks_from`, a handoff freezes its snapshot.
 * Any bad input (missing field, unknown parent/handoff, zod rejection) becomes a 400 — the viewer must
 * never crash on operator input. Redirect targets are built only from server-returned slugs (no
 * user-controlled host), so this can't be turned into an open redirect.
 */
async function handleWrite(req: Request, url: URL, db: Database): Promise<Response> {
  // Defense-in-depth (not auth): browsers stamp every request with Sec-Fetch-Site, so reject a drive-by
  // cross-site form POST while the legit same-origin forms (same-origin/same-site/none) pass. Fail open
  // when the header is absent (non-browser clients, tests) — the real CSRF vector is a browser the
  // operator points at a malicious page. The 127.0.0.1 bind is still the primary guard. See CLAUDE.md.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("forbidden: cross-site write blocked", { status: 403 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("bad request: expected a form body", { status: 400 });
  }
  const field = (k: string): string => (form.get(k) ?? "").toString().trim();
  const toProject = (pid: string) => `/?project=${encodeURIComponent(pid)}`;
  try {
    switch (url.pathname) {
      case "/w/comment": {
        // A comment is a fork with an `annotates` edge — the parent is never modified.
        const row = forkConcept(db, {
          parent_id: field("parent_id"),
          body: field("body"),
          surface: OPERATOR_SURFACE,
          kind: "annotates",
          reason: "observation",
          type: "note",
        });
        return redirect(`${toProject(row.project_id)}#${encodeURIComponent(row.id)}`);
      }
      case "/w/fork": {
        const type = field("type");
        const title = field("title");
        const row = forkConcept(db, {
          parent_id: field("parent_id"),
          body: field("body"),
          surface: OPERATOR_SURFACE,
          kind: "forks_from",
          type: (CONCEPT_TYPES as readonly string[]).includes(type) ? (type as ConceptRow["type"]) : undefined,
          title: title || undefined,
        });
        return redirect(`${toProject(row.project_id)}#${encodeURIComponent(row.id)}`);
      }
      case "/w/handoff/open": {
        const concept_ids = field("concept_ids").split(/[\s,]+/).filter(Boolean);
        const row = openHandoff(db, {
          project: field("project"),
          // Operator-originated from the viewer: the origin is always the operator surface, never a
          // submitted value (so a form post can't misattribute who handed off). openHandoff rejects an
          // empty concept_ids, so this can't mint a handoff that carries nothing.
          from_surface: OPERATOR_SURFACE,
          to_surface: field("to_surface"),
          concept_ids,
          directive: field("directive"),
        });
        return redirect(toProject(row.project_id));
      }
      case "/w/handoff/return": {
        const row = returnHandoff(db, { handoff_id: field("handoff_id"), return_note: field("return_note") });
        return redirect(toProject(row.project_id));
      }
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    return new Response(`write rejected: ${(err as Error).message}`, { status: 400 });
  }
}

// DNS-rebinding defense. The loopback bind keeps us off the network, and Sec-Fetch-Site blocks classic
// cross-site CSRF — but a page that rebinds its DNS to 127.0.0.1 is treated by the browser as same-origin
// (so Sec-Fetch-Site reads "same-origin"), while the Host header still carries the attacker's domain. So
// answer ONLY loopback Hosts; anything else is a rebinding attempt and is refused (on reads and writes).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
function hostIsLoopback(req: Request, url: URL): boolean {
  const raw = (req.headers.get("host") ?? url.host).trim().toLowerCase();
  if (raw === "") return true; // a request with no Host can't be a rebinding attack (which always sends one)
  let host = raw;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end); // [::1]:port -> ::1
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) host = host.slice(0, colon); // strip :port
  }
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Handle a viewer request: re-render the page from the pool on every load, plus (live viewer only) apply
 * same-origin form-POST write actions. Exported so the write/redirect contract is unit-testable as a
 * pure (Request, db) -> Response function, without binding a socket.
 */
export async function handleViewerRequest(req: Request, db: Database): Promise<Response> {
  const url = new URL(req.url);
  // First gate, before any routing: reject non-loopback Hosts (DNS-rebinding defense) on every request.
  if (!hostIsLoopback(req, url)) return new Response("forbidden: non-loopback Host", { status: 403 });
  if (req.method === "POST") return handleWrite(req, url, db);
  if (url.pathname === "/vendor/mermaid.min.js") {
    // Serve the vendored Mermaid bundle locally (no CDN) so diagrams render offline.
    return new Response(Bun.file(join(import.meta.dir, "..", "vendor", "mermaid.min.js")), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    // Read-only query state (server-side; no client JS). ?project= scopes to one project; type/status
    // are validated against the enums; surface is matched by id-or-label; q is a plain LIKE substring.
    const sp = url.searchParams;
    const only = sp.get("project") ?? undefined;
    const type = sp.get("type");
    const status = sp.get("status");
    const filters: Filters = {
      type: type && (CONCEPT_TYPES as readonly string[]).includes(type) ? type : undefined,
      status: status && (CONCEPT_STATUSES as readonly string[]).includes(status) ? status : undefined,
      surface: sp.get("surface") ?? undefined,
      q: sp.get("q")?.trim() || undefined,
    };
    return new Response(renderHtml(db, { live: true, only, filters }), {
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
  // The pool handle stays open for the viewer's lifetime — the viewer runs until the process exits, when
  // the OS reclaims it (tests that start/stop repeatedly do best-effort cleanup; see loop.test.ts).
  // Bind to loopback only: the viewer has write actions and no auth, so it must never be reachable off
  // this machine. 127.0.0.1 keeps it on the local interface (the deliberate v1 unauthenticated-localhost
  // posture — see CLAUDE.md). The fetch handler is async (it may apply a write before responding).
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => handleViewerRequest(req, db) });
  console.error(
    `headwater viewer live at http://127.0.0.1:${server.port}  —  Refresh re-renders from the pool`,
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
