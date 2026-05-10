// Autoresearch live dashboard.
//
// Polls research_log.jsonl every 2 s plus .eval_status.json every 1 s and
// renders the score history, per-iteration changelog, current iteration's
// per-map breakdown, and a live status pane that shows the running eval's
// current map / seed / phase.
//
// The dashboard is read-only: the loop is driven by the Node CLI
// (research_loop.ts), this just shows what's happening.

interface LogRow {
  timestamp: string;
  mode?: string;
  tag?: string | null;
  score: number;
  prev_best: number | null;
  kept: boolean;
  config_hash: string;
  config: Record<string, number>;
  per_map?: Record<
    string,
    { success_rate: number; mean_strokes_on_holed: number | null; hio_won_any_seed: boolean }
  >;
  notes?: string;
  config_was_clamped?: boolean;
  wall_secs?: number;
  map_count?: number;
}

interface LiveStatus {
  running?: boolean;
  mode?: string;
  budget?: string;
  maps?: number;
  seeds?: number[];
  tag?: string | null;
  started_at?: string;
  phase?: string;
  current_map?: string;
  current_seed?: number;
  pct?: number;
  final_score?: number;
}

interface LoopStatus {
  running?: boolean;
  iteration?: number;
  max_iterations?: number;
  prior_best?: number | null;
  phase?: "calling_agent" | "running_eval" | "dry_run" | "finished";
  log_path?: string | null;
  updated_at?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

let knownLogs: string[] = ["research_log.jsonl"];

async function discoverLogs(): Promise<string[]> {
  // Probe well-known names. The dev server returns 404 if a file
  // doesn't exist; we collect the ones that do.
  const candidates = [
    "research_log.jsonl",
    "research_validation_log.jsonl",
    "research_log_watertankrun.jsonl",
    "research_log_singlemap.jsonl",
  ];
  const found: string[] = [];
  for (const c of candidates) {
    try {
      const r = await fetch("/" + c, { method: "HEAD" });
      if (r.ok) found.push(c);
    } catch {
      // ignore
    }
  }
  return found.length > 0 ? found : ["research_log.jsonl"];
}

async function fetchLog(path: string): Promise<LogRow[]> {
  try {
    const r = await fetch("/" + path + "?_=" + Date.now());
    if (!r.ok) return [];
    const text = await r.text();
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogRow;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogRow => x !== null);
  } catch {
    return [];
  }
}

async function fetchStatus(): Promise<LiveStatus | null> {
  try {
    const r = await fetch("/.eval_status.json?_=" + Date.now());
    if (!r.ok) return null;
    return (await r.json()) as LiveStatus;
  } catch {
    return null;
  }
}

async function fetchLoopStatus(): Promise<LoopStatus | null> {
  try {
    const r = await fetch("/.loop_status.json?_=" + Date.now());
    if (!r.ok) return null;
    return (await r.json()) as LoopStatus;
  } catch {
    return null;
  }
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—";
}

function fmtScore(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : "—";
}

/** Diff two configs. Returns the keys whose values differ, with old/new
 *  values. NaN/missing handled. */
function diffConfig(
  a: Record<string, number>,
  b: Record<string, number>,
): Array<[string, number, number]> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Array<[string, number, number]> = [];
  for (const k of keys) {
    if (a[k] !== b[k]) out.push([k, a[k], b[k]]);
  }
  return out;
}

/** Render an SVG line chart. Returns an HTML string. */
function renderChart(rows: LogRow[]): string {
  if (rows.length === 0) {
    return `<div class="empty">no iterations yet — run the loop or eval to get started</div>`;
  }
  const W = 800;
  const H = 220;
  const padL = 50, padR = 14, padT = 10, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const scores = rows.map((r) => r.score);
  const minScore = Math.min(0, ...scores);
  const maxScore = Math.max(1, ...scores) || 1;
  const xOf = (i: number) =>
    padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yOf = (s: number) => padT + innerH - ((s - minScore) / (maxScore - minScore)) * innerH;

  // Best-so-far line.
  let best = -Infinity;
  const bestPath: string[] = [];
  rows.forEach((r, i) => {
    if (r.score > best) best = r.score;
    bestPath.push(`${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(best).toFixed(1)}`);
  });

  // Per-iteration line.
  const perPath = rows
    .map((r, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(r.score).toFixed(1)}`)
    .join(" ");

  // Y-axis ticks.
  const yTicks: string[] = [];
  for (let t = 0; t <= 4; t++) {
    const v = minScore + ((maxScore - minScore) * t) / 4;
    const y = yOf(v).toFixed(1);
    yTicks.push(
      `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#30363d" stroke-dasharray="2 3" />`,
      `<text x="${padL - 6}" y="${y}" text-anchor="end" alignment-baseline="middle" fill="#8b949e" font-size="10">${v.toFixed(2)}</text>`,
    );
  }

  // Iteration markers (kept = filled, reverted = hollow).
  const dots = rows
    .map((r, i) => {
      const cx = xOf(i).toFixed(1);
      const cy = yOf(r.score).toFixed(1);
      if (r.kept) {
        return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#3fb950" stroke="#161b22" stroke-width="1" />`;
      }
      return `<circle cx="${cx}" cy="${cy}" r="3" fill="#0e1116" stroke="#f85149" stroke-width="1.5" />`;
    })
    .join("");

  // X-axis labels (sparse).
  const xLabels: string[] = [];
  const stride = Math.max(1, Math.floor(rows.length / 8));
  for (let i = 0; i < rows.length; i += stride) {
    const x = xOf(i).toFixed(1);
    xLabels.push(
      `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="#8b949e" font-size="10">${i + 1}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${yTicks.join("")}
    <path d="${perPath}" fill="none" stroke="#58a6ff" stroke-width="1" opacity="0.5" />
    <path d="${bestPath.join(" ")}" fill="none" stroke="#3fb950" stroke-width="2" />
    ${dots}
    ${xLabels.join("")}
    <text x="${W - padR}" y="${padT + 12}" text-anchor="end" fill="#8b949e" font-size="10">— best so far  · per-iter</text>
  </svg>`;
}

function renderStats(rows: LogRow[]): string {
  if (rows.length === 0) return "";
  const kept = rows.filter((r) => r.kept).length;
  const last30 = rows.slice(-30);
  const last30Kept = last30.filter((r) => r.kept).length;
  const best = Math.max(...rows.map((r) => r.score));
  const initial = rows[0].score;
  const wall = rows.reduce((s, r) => s + (r.wall_secs ?? 0), 0);
  return `
    <div class="stat"><div class="num">${rows.length}</div><div class="lbl">iterations</div></div>
    <div class="stat"><div class="num">${best.toFixed(3)}</div><div class="lbl">best score</div></div>
    <div class="stat"><div class="num">${initial.toFixed(3)} → ${best.toFixed(3)}</div><div class="lbl">delta</div></div>
    <div class="stat"><div class="num">${fmtPct(kept / rows.length)}</div><div class="lbl">keep-rate</div></div>
    <div class="stat"><div class="num">${fmtPct(last30Kept / Math.max(1, last30.length))}</div><div class="lbl">last-30 keep-rate</div></div>
    <div class="stat"><div class="num">${(wall / 60).toFixed(1)}m</div><div class="lbl">total wall</div></div>
  `;
}

function renderIterList(rows: LogRow[]): string {
  if (rows.length === 0) {
    return `<div class="empty">no iterations yet</div>`;
  }
  // Newest first. We want each iteration's diff against the previous
  // KEPT config (because reverted iterations restore to prior, the
  // "real" lineage is kept→kept). For each row, walk backward to the
  // last KEPT row before it.
  const items: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    let baseline: LogRow | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].kept) {
        baseline = rows[j];
        break;
      }
    }
    const changes = baseline ? diffConfig(baseline.config, r.config) : [];
    const changesHtml =
      changes.length === 0
        ? `<div class="changes" style="color:var(--muted)">(no config diff vs prior kept)</div>`
        : `<div class="changes">${changes
            .map(
              ([k, a, b]) =>
                `<div><span class="knob">${k}</span>: <span class="from">${a}</span> → <span class="to">${b}</span></div>`,
            )
            .join("")}</div>`;
    const score = r.score;
    const prev = r.prev_best ?? -Infinity;
    const delta = Number.isFinite(prev) ? score - prev : 0;
    const deltaCls = delta > 0 ? "positive" : delta < 0 ? "negative" : "";
    const sign = delta >= 0 ? "+" : "";
    const cls = r.kept ? "kept" : "reverted";
    const badge = r.kept
      ? `<span class="badge kept">KEPT</span>`
      : `<span class="badge reverted">REVERTED</span>`;
    const tag = r.tag ? `<span class="badge">${r.tag}</span>` : "";
    items.push(`
      <div class="iter ${cls}">
        <div class="head">
          <span class="num">#${i + 1}</span>
          ${badge}
          ${tag}
          <span class="score">${fmtScore(score)} <span class="delta ${deltaCls}">${Number.isFinite(prev) ? sign + delta.toFixed(4) : "(first)"}</span></span>
        </div>
        ${changesHtml}
        ${r.notes ? `<div class="notes">${escapeHtml(r.notes)}</div>` : ""}
      </div>
    `);
  }
  return items.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPerMap(rows: LogRow[]): string {
  if (rows.length === 0) return `<div class="empty">no data</div>`;
  const r = rows[rows.length - 1];
  if (!r.per_map) return `<div class="empty">no per-map data on this iteration</div>`;
  const entries = Object.entries(r.per_map);
  entries.sort((a, b) => b[1].success_rate - a[1].success_rate);
  let html = `<div class="map-grid">
    <div class="map-row">
      <div class="h">map</div>
      <div class="h">holed</div>
      <div class="h">strokes</div>
    </div>`;
  for (const [name, m] of entries) {
    const pct = (m.success_rate * 100).toFixed(0);
    html += `
      <div class="map-row">
        <div>${escapeHtml(name)}</div>
        <div>${pct}%
          <div class="bar success"><div class="fill" style="width:${pct}%"></div></div>
        </div>
        <div>${m.mean_strokes_on_holed ?? "—"}</div>
      </div>`;
  }
  html += `</div>`;
  return html;
}

function renderLiveStatus(eval_: LiveStatus | null, loop: LoopStatus | null): string {
  const lines: string[] = [];
  if (loop && loop.running) {
    lines.push(
      `<span class="log-line ${loop.phase ?? ""}">loop: iteration ${loop.iteration}/${loop.max_iterations} — ${loop.phase}</span>`,
    );
    if (loop.prior_best != null) lines.push(`prior best: ${loop.prior_best.toFixed(4)}`);
  } else if (loop && loop.phase === "finished") {
    lines.push(`<span class="log-line done">loop: finished</span>`);
  }
  if (eval_) {
    if (eval_.phase === "done") {
      const startedAt = eval_.started_at ? new Date(eval_.started_at).toLocaleTimeString() : "?";
      lines.push(`<span class="log-line done">eval: done @ ${startedAt}, final = ${eval_.final_score?.toFixed(4) ?? "—"}</span>`);
    } else {
      lines.push(`<span class="log-line ${eval_.phase ?? ""}">eval: phase=${eval_.phase ?? "?"}</span>`);
      if (eval_.mode) lines.push(`mode=${eval_.mode}  budget=${eval_.budget ?? "?"}`);
      if (typeof eval_.maps === "number") lines.push(`maps=${eval_.maps}  seeds=${(eval_.seeds ?? []).join(",")}`);
      if (eval_.current_map) {
        const pct = eval_.pct != null ? ` ${(eval_.pct * 100).toFixed(0)}%` : "";
        lines.push(`current: ${eval_.current_map} seed=${eval_.current_seed}${pct}`);
      }
      if (eval_.tag) lines.push(`tag=${eval_.tag}`);
    }
  }
  return lines.length === 0 ? "no eval running" : lines.join("\n");
}

function setLive(connected: boolean): void {
  const el = $("live");
  if (!el) return;
  el.textContent = connected ? "● live" : "disconnected";
  el.classList.toggle("on", connected);
}

async function refresh() {
  // Re-discover logs every refresh cycle so a new log file (e.g. one
  // the user created mid-session by running a single-map loop) shows
  // up in the dropdown without a manual reload.
  const newKnown = await discoverLogs();
  const select = $<HTMLSelectElement>("log-select");
  if (select && JSON.stringify(newKnown) !== JSON.stringify(knownLogs)) {
    knownLogs = newKnown;
    const current = select.value;
    select.innerHTML = knownLogs.map((l) => `<option value="${l}">${l}</option>`).join("");
    if (knownLogs.includes(current)) select.value = current;
  }
  const path = select?.value ?? "research_log.jsonl";
  const rows = await fetchLog(path);
  const status = await fetchStatus();
  const loopStatus = await fetchLoopStatus();

  setLive(true);
  $("chart")!.innerHTML = renderChart(rows);
  $("stats")!.innerHTML = renderStats(rows);
  $("iter-list")!.innerHTML = renderIterList(rows);
  $("per-map")!.innerHTML = renderPerMap(rows);
  $("live-status")!.innerHTML = renderLiveStatus(status, loopStatus);
  $("last-refresh")!.textContent = new Date().toLocaleTimeString();
  // Keep the report link pointing at the currently-selected log.
  const reportLink = $<HTMLAnchorElement>("report-link");
  if (reportLink) reportLink.href = `/autoresearch-report.html?log=${encodeURIComponent(path)}`;
}

async function init() {
  knownLogs = await discoverLogs();
  const select = $<HTMLSelectElement>("log-select");
  if (select) {
    select.innerHTML = knownLogs.map((l) => `<option value="${l}">${l}</option>`).join("");
    select.addEventListener("change", refresh);
  }
  refresh();
  setInterval(refresh, 2000);
}

init();
