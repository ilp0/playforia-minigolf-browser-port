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

interface ApiStatus {
  running: boolean;
  pid: number | null;
  started_at: string | null;
  loop_status: LoopStatus | null;
}

interface LoopEvent {
  ts: string;
  event: string;
  iteration?: number;
  max_iterations?: number;
  prior_best?: number | null;
  score?: number;
  kept?: boolean;
  eval_secs?: number;
  proposed_chars?: number;
  secs?: number;
  signal?: string;
  reason?: string;
  interrupted?: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

let knownLogs: string[] = ["research_log.jsonl"];

async function discoverLogs(): Promise<string[]> {
  // Try Vite's filesystem listing first - it returns a directory index
  // when allowed. Falls through to a probe list if that doesn't work.
  try {
    const r = await fetch("/?_=" + Date.now());
    if (r.ok) {
      const text = await r.text();
      const matches = [
        ...new Set(text.match(/research_log[A-Za-z0-9._-]*\.jsonl/g) ?? []),
      ];
      if (matches.length > 0) return matches;
    }
  } catch {
    // ignore, fall through
  }
  const candidates = [
    "research_log.jsonl",
    "research_validation_log.jsonl",
    "research_log_watertankrun.jsonl",
    "research_log_watertankrun_5min.jsonl",
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

async function fetchApiStatus(): Promise<ApiStatus | null> {
  try {
    const r = await fetch("/api/loop/status");
    if (!r.ok) return null;
    return (await r.json()) as ApiStatus;
  } catch {
    return null;
  }
}

async function fetchEvents(): Promise<LoopEvent[]> {
  try {
    const r = await fetch("/api/loop/events?max=200");
    if (!r.ok) return [];
    const body = (await r.json()) as { events: LoopEvent[] };
    return body.events ?? [];
  } catch {
    return [];
  }
}

async function postStartLoop(body: {
  trainSecs?: number;
  mapsCsv?: string;
  logPath?: string;
  maxIterations?: number;
}): Promise<{ ok: boolean; error?: string; pid?: number }> {
  try {
    const r = await fetch("/api/loop/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function postStopLoop(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/loop/stop", { method: "POST" });
    return await r.json();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
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

function renderControls(api: ApiStatus | null): void {
  const pill = $("loop-state-pill")!;
  const text = $("loop-state-text")!;
  const btnStart = $<HTMLButtonElement>("btn-start")!;
  const btnStop = $<HTMLButtonElement>("btn-stop")!;
  const running = !!api?.running;
  pill.classList.remove("running", "stopped", "starting");
  if (running) {
    pill.classList.add("running");
    pill.textContent = "running";
    const ls = api?.loop_status;
    if (ls && ls.iteration && ls.max_iterations) {
      text.textContent = `iteration ${ls.iteration}/${ls.max_iterations} — ${ls.phase ?? "?"}`;
    } else {
      text.textContent = `pid ${api?.pid ?? "?"}`;
    }
    btnStart.disabled = true;
    btnStop.disabled = false;
  } else {
    pill.classList.add("stopped");
    pill.textContent = "stopped";
    text.textContent = "no loop running";
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
}

function renderProgressBar(eval_: LiveStatus | null, loop: LoopStatus | null): void {
  const row = $("progress-row")!;
  const fill = $("progress-fill")!;
  const txt = $("progress-text")!;
  const lbl = $("progress-label")!;
  if (!loop || !loop.running || !eval_ || eval_.phase === "done") {
    row.style.display = "none";
    return;
  }
  row.style.display = "";
  if (eval_.phase === "train" && eval_.current_map) {
    const pct = Math.max(0, Math.min(1, eval_.pct ?? 0));
    fill.style.width = `${(pct * 100).toFixed(1)}%`;
    txt.textContent = `${(pct * 100).toFixed(0)}%`;
    lbl.textContent = `iter ${loop.iteration} · training ${eval_.current_map} seed=${eval_.current_seed}`;
  } else if (eval_.phase === "eval") {
    fill.style.width = "100%";
    txt.textContent = "eval";
    lbl.textContent = `iter ${loop.iteration} · evaluating`;
  } else {
    fill.style.width = "0%";
    txt.textContent = eval_.phase ?? "...";
    lbl.textContent = `iter ${loop.iteration} · ${loop.phase}`;
  }
}

function fmtEventTs(iso: string): string {
  return iso.slice(11, 19); // HH:MM:SS
}

function renderEventLine(e: LoopEvent): string {
  const ts = `<span class="ts">${fmtEventTs(e.ts)}</span>`;
  const ev = `<span class="ev">${e.event}</span>`;
  let body = "";
  let extraCls = "";
  switch (e.event) {
    case "loop_start":
      body = `started`;
      break;
    case "iteration_start":
      body = `iter ${e.iteration}/${e.max_iterations} — prior best ${e.prior_best?.toFixed(4) ?? "(none)"}`;
      break;
    case "agent_call_start":
      body = `iter ${e.iteration} — calling agent`;
      break;
    case "agent_call_done":
      body = `iter ${e.iteration} — agent returned (${e.proposed_chars} chars, ${e.secs?.toFixed(1)}s)`;
      break;
    case "eval_start":
      body = `iter ${e.iteration} — eval starting`;
      break;
    case "iteration_done":
      body = `iter ${e.iteration} — score ${e.score?.toFixed(4)} ${e.kept ? "✓ KEPT" : "✕ REVERTED"} (eval ${e.eval_secs?.toFixed(0)}s)`;
      if (!e.kept) extraCls = "reverted";
      break;
    case "shutdown_signal":
      body = `${e.signal} received — finishing current iteration`;
      break;
    case "loop_finished":
      body = `loop finished${e.interrupted ? " (interrupted)" : ""}`;
      break;
    case "agent_call_failed":
      body = `agent call failed`;
      break;
    case "invalid_proposal":
      body = `invalid proposal: ${e.reason ?? "?"}`;
      break;
    case "eval_error":
      body = `eval error`;
      break;
    default:
      body = "";
  }
  return `<div class="event-line ${e.event} ${extraCls}">${ts}${ev}${body}</div>`;
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
  const apiStatus = await fetchApiStatus();
  const events = await fetchEvents();

  setLive(true);
  $("chart")!.innerHTML = renderChart(rows);
  $("stats")!.innerHTML = renderStats(rows);
  $("iter-list")!.innerHTML = renderIterList(rows);
  $("per-map")!.innerHTML = renderPerMap(rows);
  renderControls(apiStatus);
  renderProgressBar(status, loopStatus);
  // Render events feed (dedupe by ts+event so re-fetches don't flicker).
  const eventsEl = $("events")!;
  const wasAtBottom = eventsEl.scrollHeight - eventsEl.scrollTop - eventsEl.clientHeight < 30;
  eventsEl.innerHTML = events.length > 0
    ? events.map(renderEventLine).join("")
    : `<div class="event-line" style="color:var(--muted-2)">no events yet — start a loop to populate</div>`;
  if (wasAtBottom) eventsEl.scrollTop = eventsEl.scrollHeight;

  $("last-refresh")!.textContent = new Date().toLocaleTimeString();
  // Keep the report link pointing at the currently-selected log.
  const reportLink = $<HTMLAnchorElement>("report-link");
  if (reportLink) reportLink.href = `/autoresearch-report.html?log=${encodeURIComponent(path)}`;
}

function logPathFromMaps(mapsCsv: string): string {
  // e.g. "Watertankrun.track" -> "research_log_watertankrun.jsonl"
  if (!mapsCsv.trim()) return "research_log.jsonl";
  const slug = mapsCsv
    .split(",")[0]
    .replace(/\.track$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return `research_log_${slug}.jsonl`;
}

function bindControlHandlers() {
  const btnStart = $<HTMLButtonElement>("btn-start");
  const btnStop = $<HTMLButtonElement>("btn-stop");
  const cfgTrainSecs = $<HTMLInputElement>("cfg-train-secs");
  const cfgMaps = $<HTMLInputElement>("cfg-maps");
  const cfgLogPath = $<HTMLInputElement>("cfg-log-path");
  const cfgMaxIters = $<HTMLInputElement>("cfg-max-iters");

  // Auto-derive log path from maps when log path is blank.
  if (cfgMaps && cfgLogPath) {
    cfgMaps.addEventListener("input", () => {
      if (!cfgLogPath.value) {
        cfgLogPath.placeholder = logPathFromMaps(cfgMaps.value);
      }
    });
  }

  btnStart?.addEventListener("click", async () => {
    btnStart.disabled = true;
    const trainSecs = Number(cfgTrainSecs?.value) || 300;
    const mapsCsv = cfgMaps?.value.trim() || undefined;
    const logPath = cfgLogPath?.value.trim() || (mapsCsv ? logPathFromMaps(mapsCsv) : undefined);
    const maxIterations = Number(cfgMaxIters?.value) || 1000;
    const result = await postStartLoop({ trainSecs, mapsCsv, logPath, maxIterations });
    if (!result.ok) {
      alert("Start failed: " + (result.error ?? "unknown"));
      btnStart.disabled = false;
    } else {
      // Switch the log dropdown to whatever the loop is writing to.
      if (logPath) {
        const select = $<HTMLSelectElement>("log-select");
        if (select) {
          // Add to options if not present.
          if (!Array.from(select.options).some((o) => o.value === logPath)) {
            const opt = document.createElement("option");
            opt.value = logPath;
            opt.textContent = logPath;
            select.appendChild(opt);
          }
          select.value = logPath;
        }
      }
      refresh();
    }
  });

  btnStop?.addEventListener("click", async () => {
    btnStop.disabled = true;
    const result = await postStopLoop();
    if (!result.ok) {
      alert("Stop failed: " + (result.error ?? "unknown"));
    }
    refresh();
  });
}

async function init() {
  knownLogs = await discoverLogs();
  const select = $<HTMLSelectElement>("log-select");
  if (select) {
    select.innerHTML = knownLogs.map((l) => `<option value="${l}">${l}</option>`).join("");
    select.addEventListener("change", refresh);
  }
  bindControlHandlers();
  refresh();
  setInterval(refresh, 2000);
}

init();
