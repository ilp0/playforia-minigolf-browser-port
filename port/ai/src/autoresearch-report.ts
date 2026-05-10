// Autoresearch report - the "what did the loop accomplish" view.
//
// Different from the live dashboard (autoresearch.html / autoresearch-
// dashboard.ts), which is for "is the loop running right now." The
// report is for "after the loop finished, what changed and what does
// it mean." Static analysis: no polling, no live status, just one
// thorough render of the JSONL log.
//
// URL form:
//   /autoresearch-report.html?log=research_log_watertankrun.jsonl
//
// If no ?log= is given, the script discovers the available logs and
// picks the most recent one.

interface LogRow {
  timestamp: string;
  mode?: string;
  budget?: string;
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
  train_secs_per_map?: number;
  eval_episodes_per_map?: number;
  seeds?: number[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function getLogParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("log");
}

async function discoverLogs(): Promise<string[]> {
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
      if (r.ok) {
        // HEAD returning ok doesn't guarantee body — for JSONL we want
        // non-empty content. Vite dev server returns 200 with empty
        // body for missing files in some configs; double-check by
        // fetching size.
        const lenHdr = r.headers.get("content-length");
        if (lenHdr === null || Number(lenHdr) > 0) found.push(c);
      }
    } catch {
      // ignore
    }
  }
  return found;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtSecs(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtScore(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : "—";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

/** Diff two configs. Returns the keys whose values differ. */
function diffConfig(
  a: Record<string, number>,
  b: Record<string, number>,
): Array<[string, number, number]> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Array<[string, number, number]> = [];
  for (const k of keys) {
    if (a[k] !== b[k]) out.push([k, a[k], b[k]]);
  }
  return out.sort((x, y) => x[0].localeCompare(y[0]));
}

/** Walk back from row index `i` to the most recent KEPT row before it.
 *  Returns null if there isn't one (e.g. iter 1's "prior kept" is itself
 *  in the trivial case where it was kept). */
function priorKept(rows: LogRow[], i: number): LogRow | null {
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j].kept) return rows[j];
  }
  return null;
}

/** Pull the structured "Change: X -> Y" line from claude's NOTES. Falls
 *  back to a 1-line summary if the structured form isn't present. */
function extractHypothesis(notes: string | undefined): string | null {
  if (!notes) return null;
  // Look for "Change: foo X -> Y" or "Change: foo: X -> Y".
  const m = notes.match(/Change:\s*([^\n.]+(?:\.\s*[^\n.]+)?)/i);
  if (m) return m[1].trim();
  return null;
}

/** Detect which knobs varied across the run. Used to scope the knob
 *  trajectory section (don't show 27 charts when only 2 knobs moved). */
function variedKnobs(rows: LogRow[]): string[] {
  if (rows.length === 0) return [];
  const cfg0 = rows[0].config;
  const varied = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.config)) {
      if (r.config[k] !== cfg0[k]) varied.add(k);
    }
  }
  return [...varied].sort();
}

function totalWall(rows: LogRow[]): number {
  return rows.reduce((s, r) => s + (r.wall_secs ?? 0), 0);
}

function uniqueMaps(rows: LogRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.per_map) for (const k of Object.keys(r.per_map)) set.add(k);
  }
  return [...set];
}

function bestRow(rows: LogRow[]): LogRow {
  return rows.reduce((a, b) => (a.score >= b.score ? a : b));
}

function firstKept(rows: LogRow[]): LogRow | null {
  return rows.find((r) => r.kept) ?? null;
}

// --- rendering --------------------------------------------------------

function renderVerdict(rows: LogRow[]): string {
  if (rows.length === 0) {
    return `<div class="verdict no-improvement"><div class="icon">∅</div>
      <div><div class="headline">No iterations logged</div>
      <div class="subhead">This experiment hasn't been run yet.</div></div></div>`;
  }
  const first = rows[0];
  const best = bestRow(rows);
  const kept = rows.filter((r) => r.kept).length;
  const reverted = rows.length - kept;
  const trivialKept = rows.length === 1 || (kept === 1 && best.score <= first.score);
  // "Improvement" means the highest score is strictly above what the
  // initial config produced. If the only "kept" row was the first iter
  // (which always gets KEPT because prev_best is null), that's not real
  // improvement.
  const improved = best.score > first.score;
  const seriouslyImproved = best.score > first.score + 0.001;

  let cls = "no-improvement";
  let icon = "✕";
  let headline = "No improvement found";
  let subhead = "";

  if (seriouslyImproved) {
    cls = "improvement";
    icon = "✓";
    const delta = best.score - first.score;
    headline = `Improved by +${delta.toFixed(4)} (${(delta * 100).toFixed(1)}pp)`;
    subhead = `from ${first.score.toFixed(4)} → ${best.score.toFixed(4)} over ${rows.length} iterations`;
  } else if (improved) {
    cls = "partial";
    icon = "~";
    headline = "Marginal change";
    subhead = `${first.score.toFixed(4)} → ${best.score.toFixed(4)} — within noise`;
  } else if (trivialKept) {
    cls = "no-improvement";
    headline = "No improvement found";
    subhead = `All ${rows.length} iterations scored ${first.score.toFixed(4)}. Search space did not yield a winner at this budget.`;
  }

  return `<div class="verdict ${cls}">
    <div class="icon">${icon}</div>
    <div>
      <div class="headline">${escapeHtml(headline)}</div>
      <div class="subhead">${escapeHtml(subhead)}</div>
    </div>
  </div>`;
}

function renderStats(rows: LogRow[]): string {
  if (rows.length === 0) return "";
  const first = rows[0];
  const best = bestRow(rows);
  const kept = rows.filter((r) => r.kept).length;
  const reverted = rows.length - kept;
  const wall = totalWall(rows);
  const knobs = variedKnobs(rows);
  const maps = uniqueMaps(rows);
  return `<div class="stats">
    <div class="stat">
      <div class="label">Iterations</div>
      <div class="value">${rows.length}</div>
      <div class="sub">${kept} kept · ${reverted} reverted</div>
    </div>
    <div class="stat">
      <div class="label">Best score</div>
      <div class="value">${fmtScore(best.score)}</div>
      <div class="sub">initial: ${fmtScore(first.score)}</div>
    </div>
    <div class="stat">
      <div class="label">Total wall time</div>
      <div class="value">${fmtSecs(wall)}</div>
      <div class="sub">${(wall / Math.max(1, rows.length)).toFixed(0)}s per iter</div>
    </div>
    <div class="stat">
      <div class="label">Knobs explored</div>
      <div class="value">${knobs.length} / 27</div>
      <div class="sub">${knobs.slice(0, 4).join(", ")}${knobs.length > 4 ? ", …" : ""}</div>
    </div>
    <div class="stat">
      <div class="label">Maps</div>
      <div class="value">${maps.length}</div>
      <div class="sub">${maps.slice(0, 2).join(", ")}${maps.length > 2 ? `, +${maps.length - 2}` : ""}</div>
    </div>
  </div>`;
}

function renderScoreChart(rows: LogRow[]): string {
  if (rows.length === 0) return "";
  const W = 1000, H = 240;
  const padL = 60, padR = 20, padT = 20, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const scores = rows.map((r) => r.score);
  let min = Math.min(0, ...scores);
  let max = Math.max(1, ...scores);
  if (max === min) max = min + 1;
  const xOf = (i: number) =>
    padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yOf = (s: number) => padT + innerH - ((s - min) / (max - min)) * innerH;

  // Best-so-far
  let best = -Infinity;
  const bestPath: string[] = [];
  rows.forEach((r, i) => {
    if (r.score > best) best = r.score;
    bestPath.push(`${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(best).toFixed(1)}`);
  });

  // Per-iter
  const perPath = rows
    .map((r, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(r.score).toFixed(1)}`)
    .join(" ");

  const yTicks: string[] = [];
  for (let t = 0; t <= 4; t++) {
    const v = min + ((max - min) * t) / 4;
    const y = yOf(v).toFixed(1);
    yTicks.push(
      `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#21262d" stroke-dasharray="2 3" />`,
      `<text x="${padL - 8}" y="${y}" text-anchor="end" alignment-baseline="middle" fill="#8b949e" font-size="11">${v.toFixed(2)}</text>`,
    );
  }

  // Marker dots
  const dots = rows
    .map((r, i) => {
      const cx = xOf(i).toFixed(1);
      const cy = yOf(r.score).toFixed(1);
      const fill = r.kept ? "#3fb950" : "#0e1116";
      const stroke = r.kept ? "#161b22" : "#f85149";
      return `<g>
        <circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" stroke="${stroke}" stroke-width="${r.kept ? 1 : 1.5}" />
        <text x="${cx}" y="${(parseFloat(cy) + 16).toFixed(1)}" text-anchor="middle" fill="#8b949e" font-size="10">${i + 1}</text>
      </g>`;
    })
    .join("");

  // X axis
  const xAxis = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#30363d" />`;
  const xLabel = `<text x="${(W / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" fill="#8b949e" font-size="11">iteration</text>`;
  const yLabel = `<text x="14" y="${(padT + innerH / 2).toFixed(1)}" text-anchor="middle" fill="#8b949e" font-size="11" transform="rotate(-90 14 ${(padT + innerH / 2).toFixed(1)})">score</text>`;

  // Legend
  const legend = `<g transform="translate(${padL + 8}, ${padT + 8})">
    <line x1="0" y1="0" x2="20" y2="0" stroke="#3fb950" stroke-width="2" />
    <text x="26" y="4" fill="#8b949e" font-size="11">best so far</text>
    <line x1="120" y1="0" x2="140" y2="0" stroke="#58a6ff" stroke-width="1" />
    <text x="146" y="4" fill="#8b949e" font-size="11">per-iter</text>
    <circle cx="226" cy="0" r="4" fill="#3fb950" />
    <text x="234" y="4" fill="#8b949e" font-size="11">kept</text>
    <circle cx="280" cy="0" r="4" fill="#0e1116" stroke="#f85149" stroke-width="1.5" />
    <text x="288" y="4" fill="#8b949e" font-size="11">reverted</text>
  </g>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${yTicks.join("")}
    ${xAxis}${xLabel}${yLabel}
    <path d="${perPath}" fill="none" stroke="#58a6ff" stroke-width="1.2" opacity="0.55" />
    <path d="${bestPath.join(" ")}" fill="none" stroke="#3fb950" stroke-width="2.4" />
    ${dots}
    ${legend}
  </svg>`;
}

function renderKnobChart(knob: string, rows: LogRow[]): string {
  const W = 280, H = 70;
  const padL = 16, padR = 8, padT = 14, padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const vals = rows.map((r) => r.config[knob] ?? 0);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max === min) {
    min -= 0.5;
    max += 0.5;
  }
  const xOf = (i: number) =>
    padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yOf = (v: number) => padT + innerH - ((v - min) / (max - min)) * innerH;
  const path = vals
    .map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");
  const dots = rows
    .map((r, i) => {
      const cx = xOf(i).toFixed(1);
      const cy = yOf(vals[i]).toFixed(1);
      const fill = r.kept ? "#3fb950" : "#0e1116";
      const stroke = r.kept ? "#161b22" : "#f85149";
      return `<circle cx="${cx}" cy="${cy}" r="3" fill="${fill}" stroke="${stroke}" stroke-width="${r.kept ? 1 : 1.2}" />`;
    })
    .join("");
  const minLbl = `<text x="${padL - 4}" y="${(padT + innerH).toFixed(1)}" text-anchor="end" fill="#6e7681" font-size="9">${min}</text>`;
  const maxLbl = `<text x="${padL - 4}" y="${(padT + 6).toFixed(1)}" text-anchor="end" fill="#6e7681" font-size="9">${max}</text>`;
  return `<svg class="knob-chart" viewBox="0 0 ${W} ${H}">
    ${minLbl}${maxLbl}
    <path d="${path}" fill="none" stroke="#79c0ff" stroke-width="1.5" />
    ${dots}
  </svg>`;
}

function renderKnobs(rows: LogRow[]): string {
  const knobs = variedKnobs(rows);
  if (knobs.length === 0) {
    return `<div class="empty">No knobs were varied across iterations.</div>`;
  }
  const cards = knobs.map((k) => {
    const vals = rows.map((r) => r.config[k]);
    const distinct = [...new Set(vals)];
    return `<div class="knob-card">
      <div class="knob-name">${escapeHtml(k)}</div>
      <div class="knob-vals">${distinct.length} distinct value${distinct.length === 1 ? "" : "s"}: ${distinct.join(", ")}</div>
      ${renderKnobChart(k, rows)}
    </div>`;
  });
  return `<div class="knobs-grid">${cards.join("")}</div>`;
}

function renderIterations(rows: LogRow[]): string {
  if (rows.length === 0) return "";
  return rows
    .map((r, i) => {
      const baseline = priorKept(rows, i);
      const diffs = baseline ? diffConfig(baseline.config, r.config) : [];
      const cls = r.kept ? "kept" : "reverted";
      const badge = r.kept
        ? `<span class="badge kept">KEPT</span>`
        : `<span class="badge reverted">REVERTED</span>`;
      const prev = r.prev_best ?? -Infinity;
      const delta = Number.isFinite(prev) ? r.score - prev : 0;
      const deltaCls = delta > 0 ? "positive" : delta < 0 ? "negative" : "";
      const sign = delta >= 0 ? "+" : "";
      const deltaTxt = Number.isFinite(prev)
        ? `<span class="delta ${deltaCls}">${sign}${delta.toFixed(4)}</span>`
        : `<span class="delta">(first iteration)</span>`;
      const changesHtml =
        diffs.length === 0
          ? `<div class="changes" style="color:var(--muted)">no config diff vs prior kept</div>`
          : `<div class="changes">${diffs
              .map(
                ([k, a, b]) =>
                  `<div><span class="knob">${escapeHtml(k)}</span>: <span class="from">${a}</span><span class="arrow">→</span><span class="to">${b}</span></div>`,
              )
              .join("")}</div>`;
      const hyp = extractHypothesis(r.notes);
      const hypHtml = hyp
        ? `<h4>Hypothesis</h4><p>${escapeHtml(hyp)}</p>`
        : "";
      const notesHtml = r.notes
        ? `<h4>Reasoning</h4><blockquote>${escapeHtml(r.notes)}</blockquote>`
        : "";
      return `<div class="iter ${cls}">
        <div class="head">
          <span class="num">#${i + 1}</span>
          ${badge}
          <span class="meta">score ${fmtScore(r.score)} ${deltaTxt} · ${fmtSecs(r.wall_secs ?? 0)} · ${fmtDate(r.timestamp)}</span>
        </div>
        ${changesHtml}
        <div class="narrative">${hypHtml}${notesHtml}</div>
      </div>`;
    })
    .join("");
}

function renderConfigSideBySide(rows: LogRow[]): string {
  if (rows.length === 0) return "";
  const baseline = rows[0].config;
  const best = bestRow(rows).config;
  const allKeys = [...new Set([...Object.keys(baseline), ...Object.keys(best)])].sort();
  const baseRows = allKeys
    .map((k) => {
      const diff = baseline[k] !== best[k];
      return `<tr>
        <td class="k">${escapeHtml(k)}</td>
        <td class="v ${diff ? "diff" : ""}">${baseline[k]}</td>
      </tr>`;
    })
    .join("");
  const bestRows = allKeys
    .map((k) => {
      const diff = baseline[k] !== best[k];
      return `<tr>
        <td class="k">${escapeHtml(k)}</td>
        <td class="v ${diff ? "diff" : ""}">${best[k]}</td>
      </tr>`;
    })
    .join("");
  return `<div class="config-side-by-side">
    <div class="config-col">
      <h3>Baseline (iteration 1)</h3>
      <table>${baseRows}</table>
    </div>
    <div class="config-col">
      <h3>Best config (iteration ${rows.indexOf(bestRow(rows)) + 1})</h3>
      <table>${bestRows}</table>
    </div>
  </div>`;
}

function renderRecommendations(rows: LogRow[]): string {
  if (rows.length === 0) return "";
  const first = rows[0];
  const best = bestRow(rows);
  const improved = best.score > first.score + 0.001;
  if (improved) {
    return `<div class="recommendation">
      <h3>Next steps</h3>
      <p>The loop found a config that scored higher than the baseline. Possible follow-ups:</p>
      <ul>
        <li>Run more iterations to see if the loop can extend the win — the current best may not be a local optimum yet.</li>
        <li>Save the best config to <code>research_program.ts</code> if you want to use it as the new permanent default.</li>
        <li>Run a validation pass on a held-out map set to confirm the win generalises.</li>
      </ul>
    </div>`;
  }

  const variedSet = new Set(variedKnobs(rows));
  const candidateKnobs = [
    ["explorationBonus", "positive reward for moving away from start — directly addresses the 'stuck doing nothing' pathology"],
    ["maxStrokes", "more attempts per episode (autoresearch bound caps at 60, default 30 may not be enough on hard maps)"],
    ["initLogStd", "wider initial action distribution — try 4.2+ if it hasn't been pushed yet"],
    ["gridSize", "interacts with useNavigation; try 5 or 13 to test the trade-off"],
    ["safetyRetries", "more brute-force water rejection per stroke (capped at 12)"],
    ["lr", "an order of magnitude higher or lower than 1e-4 may help on sparse-reward problems"],
    ["gamma", "0.95 underweights late strokes; 1.0 weights all strokes equally"],
  ];
  const untried = candidateKnobs.filter(([k]) => !variedSet.has(k));

  const maps = uniqueMaps(rows);
  const isSingle = maps.length === 1;

  return `<div class="recommendation">
    <h3>Why no improvement &amp; what to try next</h3>
    <p>${rows.length} iterations all scored <code>${fmtScore(first.score)}</code> on ${isSingle ? `<code>${escapeHtml(maps[0])}</code>` : `${maps.length} maps`}.
    Either the metric isn't sensitive enough at this budget to reflect the variants tried,
    or the loop hasn't yet reached the right knob.</p>

    <h4 style="font-size:13px;color:var(--muted);margin-top:16px">Knobs not yet tried in this run</h4>
    <ul>
      ${untried.map(([k, why]) => `<li><code>${k}</code> — ${escapeHtml(why)}</li>`).join("")}
    </ul>

    <h4 style="font-size:13px;color:var(--muted);margin-top:16px">Concrete next moves</h4>
    <p>Run more iterations (the loop's local search will eventually try these knobs):</p>
    <pre>node --experimental-strip-types research_loop.ts \\
  --max-iterations 10 ${isSingle ? `\\\n  --maps ${escapeHtml(maps[0])} \\\n  --log-path research_log_${escapeHtml(maps[0]).replace(/\.track$/, "").toLowerCase()}.jsonl ` : ""}\\
  --agent-cmd 'claude --print'</pre>
    <p>Or run with a longer budget — same map, more training time per variant:</p>
    <pre>node --experimental-strip-types research_loop.ts \\
  --max-iterations 5 \\
  --budget long ${isSingle ? `\\\n  --maps ${escapeHtml(maps[0])} \\\n  --log-path research_log_${escapeHtml(maps[0]).replace(/\.track$/, "").toLowerCase()}_long.jsonl ` : ""}\\
  --agent-cmd 'claude --print'</pre>
  </div>`;
}

function renderHeaderMeta(path: string, rows: LogRow[]): string {
  if (rows.length === 0) return "";
  const first = rows[0];
  const last = rows[rows.length - 1];
  const maps = uniqueMaps(rows);
  const seeds = first.seeds ?? [];
  return `${escapeHtml(path)} · ${maps.length === 1 ? escapeHtml(maps[0]) : `${maps.length} maps`} · ${seeds.length} seeds · budget ${first.budget ?? "?"} · ${rows.length} iter${rows.length === 1 ? "" : "s"} · ${new Date(first.timestamp).toLocaleDateString()}–${new Date(last.timestamp).toLocaleDateString()}`;
}

async function render(path: string) {
  const rows = await fetchLog(path);
  $("title")!.textContent = `Autoresearch report — ${path}`;
  $("meta-line")!.textContent = renderHeaderMeta(path, rows);

  if (rows.length === 0) {
    $("content")!.innerHTML = `<div class="empty">
      No data in <code>${escapeHtml(path)}</code>. Run a loop first:<br><br>
      <code>node --experimental-strip-types research_loop.ts --max-iterations 5 --agent-cmd 'claude --print'</code>
    </div>`;
    return;
  }

  $("content")!.innerHTML = `
    ${renderVerdict(rows)}
    ${renderStats(rows)}

    <h2>Score evolution</h2>
    <div class="panel">
      ${renderScoreChart(rows)}
    </div>

    <h2>Per-knob trajectories</h2>
    ${renderKnobs(rows)}

    <h2>Iterations</h2>
    ${renderIterations(rows)}

    <h2>Configuration: baseline vs best</h2>
    <div class="panel">
      ${renderConfigSideBySide(rows)}
    </div>

    <h2>Recommendations</h2>
    ${renderRecommendations(rows)}
  `;
}

async function init() {
  $("generated-at")!.textContent = new Date().toLocaleString();

  const logs = await discoverLogs();
  const select = $<HTMLSelectElement>("log-select")!;
  if (logs.length === 0) {
    select.innerHTML = `<option value="">(no logs found)</option>`;
    $("content")!.innerHTML = `<div class="empty">No autoresearch logs found in this directory.</div>`;
    return;
  }
  select.innerHTML = logs.map((l) => `<option value="${l}">${l}</option>`).join("");

  // Pick: query param > most-recent-by-mtime (we don't have mtime so we
  // pick the first non-default log if one exists, otherwise default).
  const param = getLogParam();
  let initial = param && logs.includes(param) ? param : logs[0];
  // If there's a per-experiment log, prefer it - that's the more
  // interesting "what did we accomplish" target.
  const perExp = logs.find((l) => l.startsWith("research_log_") && l !== "research_log.jsonl");
  if (!param && perExp) initial = perExp;
  select.value = initial;

  select.addEventListener("change", () => {
    const next = select.value;
    const url = new URL(window.location.href);
    url.searchParams.set("log", next);
    history.replaceState(null, "", url.toString());
    render(next);
  });

  render(initial);
}

init();
