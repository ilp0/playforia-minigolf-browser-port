// Grid view: trains every PICKER map concurrently, one cell per map.
// Each cell owns its own agent, episode, trace, and renderer; they all
// share one rAF pump. Used both as the "calculate every map" batch tool
// and as a visualisation of multiple training runs in parallel.
//
// Persistence: each cell auto-loads its saved policy on startup (if one
// exists in localStorage) and auto-saves on the same milestones as the
// single-map view (best-improved / converged / perfected).

import { PICKER, loadTrackByFile, listAllTracks } from "./tracks.ts";
import { loadTrack, type LoadedTrack } from "./loader.ts";
import { Episode, episodeReturn } from "./env.ts";
import { MLPAgent, type PolicyStep } from "./agent.ts";
import { createRenderer, type AIRenderer } from "./render.ts";
import {
  savePolicy,
  loadPolicy,
  listSavedPolicies,
  deletePolicy,
  saveGridMaps,
  loadGridMaps,
  POLICY_VERSION,
  type SavedPolicy,
} from "./storage.ts";

/** Each grid cell is one independent training run. The agent, episode,
 *  trace, and renderer are all per-cell; only the rAF pump is shared. */
interface Cell {
  file: string;
  label: string;
  track: LoadedTrack;
  agent: MLPAgent;
  renderer: AIRenderer;
  /** One visible episode per cell - keeps the canvas readable. The grid
   *  itself is the parallelism, not within each cell. */
  episode: Episode;
  trace: PolicyStep[];
  episodeIndex: number;
  bestStrokes: number;
  recentSuccesses: number[];
  lifetimeReturnsSum: number;
  lifetimeReturnsCount: number;
  perfected: boolean;
  lastSavedStatus: "" | "BEST_IMPROVED" | "CONVERGED" | "PERFECTED";
  lastSavedBest: number;
  /** Recorded action sequence from the best-ever episode. Replayed in
   *  demo mode (when status is solved) so the grid shows the actual
   *  best-known route, not the deterministic policy mean (which is
   *  rarely the best individual attempt). */
  bestActions: Array<{ dx: number; dy: number }> | null;
  // DOM
  canvas: HTMLCanvasElement;
  statusEl: HTMLElement;
  epEl: HTMLElement;
  bestEl: HTMLElement;
  successEl: HTMLElement;
}

const RECENT_WINDOW = 50;
const cells: Cell[] = [];
/** Physics ticks per cell per rAF callback. Scales the apparent animation
 *  speed: every render advances the simulation by this many ticks, so
 *  cranking the slider up makes balls visibly travel further per frame.
 *  We always render every frame (no skip-above-threshold) so the motion
 *  smoothly accelerates as the user drags - no abrupt cutoff. fps drops
 *  naturally at very high values because each frame takes longer. */
let physicsPerFrame = 30;

const grid = document.getElementById("grid") as HTMLElement;
const speedSlider = document.getElementById("grid-speed") as HTMLInputElement;
const speedLabel = document.getElementById("grid-speed-label");
const solvedCount = document.getElementById("solved-count");
const totalCount = document.getElementById("total-count");
const totalEpisodes = document.getElementById("total-episodes");
const clearBtn = document.getElementById("grid-clear");
const addSelect = document.getElementById("grid-add-map") as HTMLSelectElement | null;
const addBtn = document.getElementById("grid-add-btn");
const resetCuratedBtn = document.getElementById("grid-reset-curated");
const clearAllBtn = document.getElementById("grid-clear-all");

if (!grid) throw new Error("missing #grid");

/** Persist whatever maps are currently in the grid. Called after every
 *  add/remove/reset so the same selection comes back on reload. */
function persistSelection() {
  saveGridMaps(cells.map((c) => c.file));
  if (totalCount) totalCount.textContent = String(cells.length);
}

async function init() {
  // Populate the "+ add map" dropdown with every available track. Same
  // optgroup pattern as the single-map view (curated up top, all others
  // below) so users can find familiar names quickly.
  if (addSelect) {
    const all = listAllTracks();
    const curated = all.filter((t) => t.curated);
    const others = all.filter((t) => !t.curated);
    const cg = document.createElement("optgroup");
    cg.label = `curated (${curated.length})`;
    for (const t of curated) {
      const opt = document.createElement("option");
      opt.value = t.file;
      opt.textContent = t.label;
      cg.appendChild(opt);
    }
    addSelect.appendChild(cg);
    const og = document.createElement("optgroup");
    og.label = `all maps (${others.length})`;
    for (const t of others) {
      const opt = document.createElement("option");
      opt.value = t.file;
      opt.textContent = t.label;
      og.appendChild(opt);
    }
    addSelect.appendChild(og);
  }

  // Initial selection: persisted list if present, else the curated 6.
  const saved = loadGridMaps();
  const initialFiles =
    saved && saved.length > 0 ? saved : PICKER.map((p) => p.file);
  const lookupLabel = (file: string) => {
    const all = listAllTracks();
    return all.find((t) => t.file === file)?.label ?? file.replace(/\.track$/i, "");
  };
  const built = await Promise.all(
    initialFiles.map((file) => createCell(file, lookupLabel(file))),
  );
  for (const c of built) {
    cells.push(c);
    grid.appendChild(c.canvas.closest(".cell")!);
  }
  persistSelection();

  if (speedSlider) {
    const updateLabel = () => {
      if (!speedLabel) return;
      speedLabel.textContent = String(physicsPerFrame);
    };
    speedSlider.addEventListener("input", () => {
      physicsPerFrame = Math.max(1, Number(speedSlider.value) || 1);
      updateLabel();
    });
    updateLabel();
  }

  addBtn?.addEventListener("click", async () => {
    if (!addSelect || !addSelect.value) return;
    const file = addSelect.value;
    if (cells.some((c) => c.file === file)) {
      // Already in the grid - flash the existing cell instead of duplicating.
      const existing = cells.find((c) => c.file === file);
      if (existing) {
        const el = existing.canvas.closest(".cell") as HTMLElement;
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    const c = await createCell(file, lookupLabel(file));
    cells.push(c);
    grid.appendChild(c.canvas.closest(".cell")!);
    persistSelection();
    refreshOverallCounts();
  });

  resetCuratedBtn?.addEventListener("click", async () => {
    // Replace the current set with the curated 6.
    removeAllCells();
    const built = await Promise.all(
      PICKER.map((p) => createCell(p.file, p.label)),
    );
    for (const c of built) {
      cells.push(c);
      grid.appendChild(c.canvas.closest(".cell")!);
    }
    persistSelection();
    refreshOverallCounts();
  });

  clearAllBtn?.addEventListener("click", () => {
    removeAllCells();
    persistSelection();
    refreshOverallCounts();
  });

  clearBtn?.addEventListener("click", () => {
    if (!confirm("Delete ALL saved policies? Each cell will reset to a random network.")) return;
    for (const c of cells) {
      deletePolicy(c.file);
      c.agent = newAgent();
      c.agent.setMap(c.track.map);
      c.bestStrokes = Infinity;
      c.recentSuccesses = [];
      c.lifetimeReturnsSum = 0;
      c.lifetimeReturnsCount = 0;
      c.perfected = false;
      c.lastSavedStatus = "";
      c.lastSavedBest = Infinity;
      c.episodeIndex = 0;
      c.episode = new Episode(c.track, { maxStrokes: 30, seed: 1 });
      c.trace = [];
      c.bestActions = null;
      updateCellUI(c);
    }
    refreshOverallCounts();
  });

  refreshOverallCounts();
  requestAnimationFrame(frame);
}

/** Detach a cell from the grid: drop its DOM and remove it from `cells`.
 *  The agent + episode + renderer become unreferenced and get GC'd
 *  along with the offscreen background canvas they were holding. */
function removeCell(file: string): void {
  const idx = cells.findIndex((c) => c.file === file);
  if (idx < 0) return;
  const c = cells[idx];
  const el = c.canvas.closest(".cell");
  el?.parentElement?.removeChild(el);
  cells.splice(idx, 1);
  persistSelection();
  refreshOverallCounts();
}

function removeAllCells(): void {
  for (const c of cells.slice()) {
    const el = c.canvas.closest(".cell");
    el?.parentElement?.removeChild(el);
  }
  cells.length = 0;
}

function newAgent(): MLPAgent {
  return new MLPAgent({ lr: 1e-4, gamma: 0.99, batchSize: 4 });
}

/** Compact "YYYY-MM" date for the cramped grid cell. Same epoch handling
 *  as the main page (some old entries are in seconds, not ms). */
function formatEpochShort(ms: number): string {
  let d = new Date(ms);
  if (d.getUTCFullYear() < 1990) d = new Date(ms * 1000);
  if (isNaN(d.getTime())) return "—";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

async function createCell(file: string, label: string): Promise<Cell> {
  const text = await loadTrackByFile(file);
  const track = await loadTrack(text);
  const agent = newAgent();
  agent.setMap(track.map);

  // Try to restore a previously trained policy.
  const saved = loadPolicy(file);
  let initialBest = Infinity;
  let initialPerfected = false;
  let initialStatus: Cell["lastSavedStatus"] = "";
  // Restored runtime stats from the saved policy, so the cell's visible
  // counters (ep, success, lifetime avg) survive a refresh instead of
  // showing 0/—.
  let initialEpisodeIndex = 0;
  let initialReturnsSum = 0;
  let initialRecentSuccesses: number[] = [];
  let initialRecentReturns: number[] = [];
  let initialBestActions: Cell["bestActions"] = null;
  if (saved && agent.loadSerialized(saved)) {
    initialBest = saved.bestStrokes;
    initialStatus = saved.status;
    initialEpisodeIndex = saved.episodesTrained ?? 0;
    initialReturnsSum = saved.lifetimeReturnsSum ?? 0;
    initialRecentSuccesses = saved.recentSuccesses ?? [];
    initialRecentReturns = saved.recentReturns ?? [];
    initialBestActions = saved.bestActions ?? null;
    if (saved.status === "PERFECTED") {
      initialPerfected = true;
      agent.evalMode = true;
    } else if (saved.status === "CONVERGED") {
      // Same demo treatment for converged cells: deterministic playback,
      // no further training. The user explicitly asked for this -
      // "no need to run the simulation when perfected or converged".
      agent.evalMode = true;
    }
  }

  const renderer = createRenderer(track);
  const episode = new Episode(track, { maxStrokes: 30, seed: 1 });

  // DOM scaffold for this cell.
  const dom = document.createElement("div");
  dom.className = "cell";
  dom.innerHTML = `
    <div class="cell-head">
      <div class="cell-name"></div>
      <div class="status training">TRAINING</div>
      <button class="cell-remove" title="Remove this map from the grid">×</button>
    </div>
    <canvas width="735" height="375"></canvas>
    <div class="cell-stats">
      <span>ep <b class="ep">0</b></span>
      <span>best <b class="best">—</b></span>
      <span>success <b class="success">—</b></span>
    </div>
    <div class="cell-meta">
      <div><span class="meta-label">author</span><b class="meta-author">—</b></div>
      <div><span class="meta-label">par</span><b class="meta-par">—</b></div>
      <div><span class="meta-label">record</span><b class="meta-record">—</b></div>
      <div><span class="meta-label">plays</span><b class="meta-plays">—</b></div>
      <div><span class="meta-label">avg</span><b class="meta-avg">—</b></div>
      <div><span class="meta-label">set</span><b class="meta-set">—</b></div>
    </div>
  `;
  const nameEl = dom.querySelector(".cell-name") as HTMLElement;
  nameEl.textContent = label;
  // Remove-from-grid button. Each cell drops itself; the agent and any
  // references go out of scope and the canvas is GC'd. (We DON'T delete
  // the saved policy - the user might want it back later.)
  const removeBtn = dom.querySelector(".cell-remove") as HTMLButtonElement | null;
  removeBtn?.addEventListener("click", () => removeCell(file));
  // Populate the original-database metadata inline (it's static per map).
  const m = track.meta;
  const setText = (sel: string, v: string) => {
    const el = dom.querySelector(sel);
    if (el) el.textContent = v;
  };
  setText(".meta-author", m.author || "—");
  setText(".meta-par", m.bestPar > 0 ? `${m.bestPar}` : "—");
  setText(".meta-record", m.bestPlayer ?? "—");
  setText(".meta-plays", m.plays > 0 ? m.plays.toLocaleString() : "—");
  setText(
    ".meta-avg",
    m.plays > 0 && m.strokes > 0 ? (m.strokes / m.plays).toFixed(2) : "—",
  );
  setText(".meta-set", m.bestParEpoch ? formatEpochShort(m.bestParEpoch) : "—");

  const cell: Cell = {
    file,
    label,
    track,
    agent,
    renderer,
    episode,
    trace: [],
    episodeIndex: initialEpisodeIndex,
    bestStrokes: initialBest,
    recentSuccesses: initialRecentSuccesses.slice(),
    lifetimeReturnsSum: initialReturnsSum,
    // Treat the restored episodes as already counted toward the lifetime
    // total so the avg-R math matches the persisted sum.
    lifetimeReturnsCount: initialEpisodeIndex,
    perfected: initialPerfected,
    lastSavedStatus: initialStatus,
    lastSavedBest: initialBest,
    bestActions: initialBestActions,
    canvas: dom.querySelector("canvas") as HTMLCanvasElement,
    statusEl: dom.querySelector(".status") as HTMLElement,
    epEl: dom.querySelector(".ep") as HTMLElement,
    bestEl: dom.querySelector(".best") as HTMLElement,
    successEl: dom.querySelector(".success") as HTMLElement,
  };

  // Initial UI render reflects the loaded-or-fresh state.
  updateCellUI(cell);

  return cell;
}

function refreshOverallCounts() {
  // Count cells whose status is CONVERGED or PERFECTED, vs total cells.
  // (Different from "saved policies in localStorage" - we want what's
  // visible in the grid right now.)
  let solved = 0;
  for (const c of cells) {
    const s = statusOf(c).cls;
    if (s === "converged" || s === "perfected") solved++;
  }
  if (solvedCount) solvedCount.textContent = String(solved);
  if (totalCount) totalCount.textContent = String(cells.length);
  if (totalEpisodes) {
    let sum = 0;
    for (const c of cells) sum += c.episodeIndex;
    totalEpisodes.textContent = String(sum);
  }
  // listSavedPolicies imported but unused after the refactor; reference it
  // here so future "compare grid to total saved" features can find it.
  void listSavedPolicies;
}

function endAndReset(cell: Cell) {
  const ret = episodeReturn(cell.episode);
  if (!cell.agent.evalMode && cell.trace.length > 0) {
    // Constant-return-per-step (γ=1 effective for the train signal); the
    // agent's V baseline still uses γ=0.99 internally for the per-step
    // returns array. Using ret as scalar keeps things simple here -
    // value baseline still helps via the V head.
    const arr = new Array<number>(cell.episode.strokes).fill(ret);
    cell.agent.train(cell.trace, arr);
  }

  const holed = cell.episode.state().status === "holed";
  cell.recentSuccesses.push(holed ? 1 : 0);
  if (cell.recentSuccesses.length > RECENT_WINDOW) cell.recentSuccesses.shift();
  if (holed && cell.episode.strokes < cell.bestStrokes) {
    cell.bestStrokes = cell.episode.strokes;
    // Capture this episode's exact action sequence as the new best route.
    // Each PolicyStep's (actionX, actionY) is the noisy sample that was
    // sent to physics, NOT the deterministic policy mean — the noise is
    // why this run was better than average, so we want to keep it.
    cell.bestActions = cell.trace.map((s) => ({ dx: s.actionX, dy: s.actionY }));
  }
  cell.lifetimeReturnsSum += ret;
  cell.lifetimeReturnsCount += 1;

  // Only crown PERFECTED when the agent holes in 1 with the *deterministic*
  // policy (evalMode already on). A stochastic hole-in-1 during training
  // is just a lucky sample; the policy mean might not actually hole in 1
  // when noise is removed, which would make the demo loop visibly fail.
  if (holed && cell.episode.strokes === 1 && !cell.perfected && cell.agent.evalMode) {
    cell.perfected = true;
  }

  // Once a cell reaches CONVERGED or PERFECTED, drop into demo mode -
  // stop training, play the deterministic policy at game speed forever.
  // The user asked for this: no point burning CPU on a solved map.
  const status = statusOf(cell);
  if ((status.cls === "converged" || status.cls === "perfected") && !cell.agent.evalMode) {
    cell.agent.evalMode = true;
  }

  cell.episodeIndex++;
  cell.episode = new Episode(cell.track, { maxStrokes: 30, seed: cell.episodeIndex + 1 });
  cell.trace = [];

  maybePersist(cell, holed);
  updateCellUI(cell);
}

function statusOf(cell: Cell): {
  cls: "training" | "converging" | "converged" | "perfected" | "loaded";
  label: string;
} {
  if (cell.perfected) return { cls: "perfected", label: "PERFECTED" };
  const success =
    cell.recentSuccesses.length > 0
      ? cell.recentSuccesses.reduce((a, b) => a + b, 0) / cell.recentSuccesses.length
      : 0;
  if (
    cell.lifetimeReturnsCount >= 30 &&
    cell.recentSuccesses.length >= 50 &&
    success >= 0.9
  ) {
    return { cls: "converged", label: "CONVERGED" };
  }
  // If we loaded a CONVERGED snapshot but haven't generated 50 fresh runs
  // here yet, surface that with a distinct "LOADED" badge so the user
  // doesn't think the cell is starting from scratch.
  if (
    cell.lastSavedStatus === "CONVERGED" &&
    cell.recentSuccesses.length < 50
  ) {
    return { cls: "loaded", label: "LOADED" };
  }
  if (success >= 0.5) return { cls: "converging", label: "CONVERGING" };
  return { cls: "training", label: "TRAINING" };
}

function updateCellUI(cell: Cell) {
  const { cls, label } = statusOf(cell);
  cell.statusEl.textContent = label;
  cell.statusEl.className = `status ${cls}`;
  cell.epEl.textContent = String(cell.episodeIndex);
  cell.bestEl.textContent = cell.bestStrokes === Infinity ? "—" : String(cell.bestStrokes);
  const success =
    cell.recentSuccesses.length > 0
      ? cell.recentSuccesses.reduce((a, b) => a + b, 0) / cell.recentSuccesses.length
      : 0;
  cell.successEl.textContent =
    cell.recentSuccesses.length > 0 ? `${(success * 100).toFixed(0)}%` : "—";
}

function maybePersist(cell: Cell, holed: boolean) {
  const success =
    cell.recentSuccesses.length > 0
      ? cell.recentSuccesses.reduce((a, b) => a + b, 0) / cell.recentSuccesses.length
      : 0;
  let tier: SavedPolicy["status"] | null = null;
  if (cell.perfected) tier = "PERFECTED";
  else if (
    cell.lifetimeReturnsCount >= 30 &&
    cell.recentSuccesses.length >= 50 &&
    success >= 0.9
  ) tier = "CONVERGED";
  else if (holed && cell.bestStrokes < cell.lastSavedBest) tier = "BEST_IMPROVED";

  if (!tier) return;
  // Re-save periodically (every 50 episodes after the milestone) so the
  // rolling-window stats in localStorage stay roughly current. Without
  // this, a cell that hit PERFECTED at ep 100 would keep showing the
  // ep-100 snapshot of success/avg-R forever even after thousands of
  // demo loops.
  const refreshInterval = 50;
  const dueForRefresh =
    tier === cell.lastSavedStatus &&
    cell.lifetimeReturnsCount > 0 &&
    cell.lifetimeReturnsCount % refreshInterval === 0;
  if (
    tier === cell.lastSavedStatus &&
    cell.bestStrokes >= cell.lastSavedBest &&
    !dueForRefresh
  ) return;

  const data = cell.agent.toSerialized();
  savePolicy({
    version: POLICY_VERSION,
    filename: cell.file,
    bestStrokes: cell.bestStrokes,
    status: tier,
    episodesTrained: cell.lifetimeReturnsCount,
    savedAt: Date.now(),
    // Persist runtime stats so the visible counters and rolling-window
    // success rate survive a page refresh.
    lifetimeReturnsSum: cell.lifetimeReturnsSum,
    recentSuccesses: cell.recentSuccesses.slice(),
    bestActions: cell.bestActions ?? undefined,
    ...data,
  });
  cell.lastSavedStatus = tier;
  cell.lastSavedBest = cell.bestStrokes;
  refreshOverallCounts();
}

let lastCountsUpdate = 0;
function frame(_time: number) {
  if (cells.length === 0) {
    requestAnimationFrame(frame);
    return;
  }

  // Single sim pass per rAF: each cell advances by `physicsPerFrame` ticks
  // when training. Cells in demo mode (evalMode = true after solving)
  // use ~game speed — the optimal path is what we're showing now, no
  // point fast-forwarding through it.
  const DEMO_TICKS_PER_FRAME = 3; // ≈ 166Hz physics / 60Hz screen ≈ real time
  for (const cell of cells) {
    const state = cell.episode.state();
    if (state.status === "holed" || state.status === "out_of_strokes") {
      endAndReset(cell);
    } else if (state.status === "awaiting_shot") {
      // In demo mode (cell solved), prefer replaying the recorded best
      // route over the deterministic policy mean - the user explicitly
      // wanted "the best score route, not the weighted average". The
      // policy mean often misses what a noise-lucky run achieved.
      const isDemo = cell.agent.evalMode;
      const stroke = cell.episode.strokes; // 0-indexed for next stroke
      let action;
      if (isDemo && cell.bestActions && stroke < cell.bestActions.length) {
        action = cell.bestActions[stroke];
      } else {
        action = cell.agent.actAndTrace(state, cell.trace);
      }
      cell.episode.applyShot(action);
    } else {
      const ticks = cell.agent.evalMode ? DEMO_TICKS_PER_FRAME : physicsPerFrame;
      cell.episode.tick(ticks);
    }
  }

  // Always render. fps drops naturally at very high slider values
  // because the sim work fills the frame budget, but motion stays
  // continuous - which is what you want for a video capture.
  for (const cell of cells) {
    cell.renderer.render(cell.canvas, [cell.episode]);
  }

  // Throttle the overall counts update — it scans every cell + localStorage.
  const now = performance.now();
  if (now - lastCountsUpdate > 1000) {
    refreshOverallCounts();
    lastCountsUpdate = now;
  }
  requestAnimationFrame(frame);
}

init().catch((err) => {
  console.error("Grid view failed to start:", err);
  if (grid) grid.textContent = "ERROR (see console)";
});
