// Entry point. Drives N parallel episodes through one shared actor-critic
// network and trains in batches of `batchSize` finished episodes.
//
// Multi-env: every frame we tick all N episodes, each with its own trace.
// When any episode finishes, its trace+returns get accumulated into the
// agent's gradient buffer; every `batchSize` finished episodes the agent
// applies one averaged gradient step. The renderer draws all N balls
// simultaneously so users can see the parallel rollouts.

import { PICKER, DEFAULT_TRACK_FILE, loadTrackByFile, listAllTracks } from "./tracks.ts";
import { loadTrack, type LoadedTrack } from "./loader.ts";
import {
  Episode,
  episodeReturn,
  discountedPerStepReturns,
  isConverged,
} from "./env.ts";
import { MLPAgent, type PolicyStep } from "./agent.ts";
import { createRenderer, type AIRenderer } from "./render.ts";
import { RewardChart } from "./chart.ts";
import {
  savePolicy,
  loadPolicy,
  POLICY_VERSION,
  type SavedPolicy,
} from "./storage.ts";
import {
  loadConfig,
  saveConfig,
  DEFAULTS as CONFIG_DEFAULTS,
  BOUNDS as CONFIG_BOUNDS,
  ARCHITECTURE_KEYS,
  type TrainingConfig,
} from "./config.ts";
import { extractRoute } from "./path.ts";
import { searchHoleInOne } from "./hio.ts";

const stage = document.getElementById("stage") as HTMLCanvasElement | null;
const chartCanvas = document.getElementById("chart") as HTMLCanvasElement | null;
const statMap = document.getElementById("stat-map");
const statEpisode = document.getElementById("stat-episode");
const statStrokes = document.getElementById("stat-strokes");
const statLast = document.getElementById("stat-last");
const btnReset = document.getElementById("btn-reset");
const btnResetAgent = document.getElementById("btn-reset-agent");
const modeSelect = document.getElementById("mode-select") as HTMLSelectElement | null;
const mapSelect = document.getElementById("map-select") as HTMLSelectElement | null;
const speedSlider = document.getElementById("speed-slider") as HTMLInputElement | null;
const speedLabel = document.getElementById("speed-label");
const evalIndicator = document.getElementById("eval-indicator");

if (!stage) throw new Error("missing #stage canvas");

let track: LoadedTrack;
let renderer: AIRenderer;
let agent: MLPAgent;
let episodes: Episode[] = [];
let traces: PolicyStep[][] = [];
let episodeIndex = 0;
let chart: RewardChart | null = null;
/** The training config currently driving the agent. Loaded per-map from
 *  localStorage (defaults if no save). When the user edits a knob in the
 *  UI it goes here, then either applies live to the agent (most knobs)
 *  or rebuilds the agent (architectural knobs). */
let cfg: TrainingConfig = { ...CONFIG_DEFAULTS };

const RECENT_WINDOW = 50;
const recentReturns: number[] = [];
const recentSuccesses: number[] = [];
let bestStrokes = Infinity;

/**
 * Lifetime stats for the CURRENT map (reset on map switch). The header's
 * "mean R(50)" is a rolling window for "what's the policy doing right now";
 * this lifetime average is "how is this map going overall" - more useful
 * when comparing maps or watching long training runs.
 */
let lifetimeReturnsSum = 0;
let lifetimeReturnsCount = 0;

/** Once we hit a hole-in-1 we freeze the agent (eval mode on). The user
 *  asked: "always stop if we find 1" - one stroke is the optimal possible
 *  outcome on any map, so further training can only worsen the policy. */
let perfected = false;

/** Filename of the .track currently loaded - used as the persistence key. */
let currentMapFile = "";

/** Toggle for the pathfinder-route overlay on the canvas. Bound to the
 *  `#show-route` checkbox in the controls section. */
let showRoute = false;

/** Generation counter for the HIO pre-search. Bumped on every map load;
 *  in-flight searches check this against their captured value and bail
 *  early if it changed - prevents a slow search on map A from
 *  accidentally writing its result onto map B if the user switched
 *  maps mid-search. */
let hioSearchGeneration = 0;
/** Set true while an HIO search is running for the current map. The
 *  frame loop short-circuits training while this is true so the agent
 *  doesn't burn cycles on a map we're about to confirm-perfect. */
let hioSearchInProgress = false;

/** Persistent canvas the HIO search paints into as it tries each
 *  candidate. The frame loop composites this layer onto the stage so
 *  the user sees the search building up live - a fan of dashed lines
 *  fanning out from the start position, colour-coded by outcome.
 *  Allocated lazily; cleared when a new search starts. */
let hioOverlayCanvas: HTMLCanvasElement | null = null;
let hioOverlayCtx: CanvasRenderingContext2D | null = null;
function ensureHioOverlay(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (hioOverlayCanvas && hioOverlayCtx) return { canvas: hioOverlayCanvas, ctx: hioOverlayCtx };
  const c = document.createElement("canvas");
  c.width = 735;
  c.height = 375;
  const x = c.getContext("2d");
  if (!x) throw new Error("HIO overlay 2d context unavailable");
  hioOverlayCanvas = c;
  hioOverlayCtx = x;
  return { canvas: c, ctx: x };
}
function clearHioOverlay(): void {
  if (hioOverlayCtx && hioOverlayCanvas) {
    hioOverlayCtx.clearRect(0, 0, hioOverlayCanvas.width, hioOverlayCanvas.height);
  }
}

/** Paint one HIO-search candidate onto the overlay: a faint line from
 *  the ball's start position to where the shot ended up, plus a small
 *  dot at the resting position. Colour-coded by outcome so the user
 *  can read the search at a glance:
 *    - holed → bright gold (the winning shot, drawn last on success)
 *    - water → cyan/blue
 *    - acid  → orange/red
 *    - normal (rolled-and-stopped on grass) → green
 *  Lines use very low alpha so 35 000 of them accumulate into a
 *  density "fan" of where the ball can reach. Dots are slightly more
 *  opaque so the resting points stand out. */
function paintHioCandidate(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  outcome: "normal" | "water" | "acid" | "holed",
): void {
  let line: string;
  let dot: string;
  switch (outcome) {
    case "holed":
      line = "rgba(255,215,0,0.95)";
      dot = "rgba(255,215,0,1)";
      break;
    case "water":
      line = "rgba(80,180,255,0.05)";
      dot = "rgba(80,180,255,0.4)";
      break;
    case "acid":
      line = "rgba(255,120,80,0.05)";
      dot = "rgba(255,120,80,0.4)";
      break;
    default:
      line = "rgba(120,255,150,0.04)";
      dot = "rgba(120,255,150,0.5)";
  }
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.fillStyle = dot;
  ctx.fillRect(endX - 1, endY - 1, 2, 2);
}

/** UI mode: training (stochastic + weight updates), eval (deterministic
 *  policy mean, weights frozen), best (replay the recorded best route).
 *  Switching modes only changes how actions are produced — it doesn't
 *  reset weights or stats. */
type RunMode = "training" | "eval" | "best";
let runMode: RunMode = "training";

/** Recorded action sequence from the best-ever episode on the current
 *  map. Set when bestStrokes improves; replayed in "best" mode. */
let bestActions: Array<{ dx: number; dy: number }> | null = null;

/** Switch run modes. Pauses or resumes training without resetting weights
 *  or stats, per the user requirement: "Changing this mode should just
 *  pause the training, not replace it." */
function setMode(m: RunMode): void {
  runMode = m;
  if (agent) {
    // evalMode controls action sampling (mean vs noisy). Both eval and
    // best modes use deterministic-ish actions (best replays recorded
    // ones; eval uses the policy mean) — no exploration noise either way.
    agent.evalMode = m !== "training";
  }
  if (modeSelect) modeSelect.value = m;
  if (evalIndicator) {
    if (m === "training") {
      evalIndicator.textContent = "TRAIN";
      evalIndicator.style.color = "#ffd24f";
    } else if (m === "eval") {
      evalIndicator.textContent = "EVAL (frozen)";
      evalIndicator.style.color = "#7fffaa";
    } else {
      evalIndicator.textContent = "BEST (replay)";
      evalIndicator.style.color = "#b0bcff";
    }
  }
}

/** Last status we persisted, so we don't re-save the same milestone every
 *  episode once the policy converges. Reset on map change. */
let lastSavedStatus: "" | "BEST_IMPROVED" | "CONVERGED" | "PERFECTED" = "";
let lastSavedBest = Infinity;

/** Physics ticks per episode per rAF callback. Higher = balls visibly
 *  travel further between renders. We always render every frame so motion
 *  smoothly accelerates with the slider — no abrupt cutoff. fps drops
 *  naturally at very high values (sim work fills the frame budget). */
let physicsPerFrame = 30;

async function main() {
  if (mapSelect) {
    // Two optgroups: curated maps up top for quick access, then every
    // other .track file in the upstream resources tree (~2 000 entries).
    // Browser native typeahead works on optgroups: tap a letter and the
    // selection jumps to the next entry whose label starts with it.
    const all = listAllTracks();
    const curated = all.filter((t) => t.curated);
    const others = all.filter((t) => !t.curated);

    const curatedGroup = document.createElement("optgroup");
    curatedGroup.label = `curated (${curated.length})`;
    for (const t of curated) {
      const opt = document.createElement("option");
      opt.value = t.file;
      opt.textContent = t.label;
      curatedGroup.appendChild(opt);
    }
    mapSelect.appendChild(curatedGroup);

    const allGroup = document.createElement("optgroup");
    allGroup.label = `all maps (${others.length})`;
    for (const t of others) {
      const opt = document.createElement("option");
      opt.value = t.file;
      opt.textContent = t.label;
      allGroup.appendChild(opt);
    }
    mapSelect.appendChild(allGroup);

    mapSelect.value = DEFAULT_TRACK_FILE;
    mapSelect.addEventListener("change", () => {
      void loadMap(mapSelect.value, /*resetAgent=*/ true);
    });
  }
  void PICKER;

  if (chartCanvas) {
    chart = new RewardChart(chartCanvas, { windowSize: 25, maxPoints: 500 });
  }

  await loadMap(DEFAULT_TRACK_FILE, /*resetAgent=*/ true);

  modeSelect?.addEventListener("change", () => {
    setMode(modeSelect.value as RunMode);
  });

  btnReset?.addEventListener("click", () => {
    // End all in-flight episodes (and credit them).
    for (let i = 0; i < episodes.length; i++) endAndReset(i);
  });

  btnResetAgent?.addEventListener("click", () => {
    void loadMap(mapSelect?.value ?? DEFAULT_TRACK_FILE, /*resetAgent=*/ true);
  });

  if (speedSlider) {
    const updateSpeedLabel = () => {
      if (!speedLabel) return;
      speedLabel.textContent = `${physicsPerFrame} steps/frame`;
    };
    speedSlider.addEventListener("input", () => {
      physicsPerFrame = Math.max(1, Number(speedSlider.value) || 1);
      updateSpeedLabel();
    });
    updateSpeedLabel();
  }

  // Pathfinder-route overlay toggle. Persisted to localStorage so the
  // user's choice survives a refresh (it's a UI preference, not a
  // per-map setting).
  const routeToggle = document.getElementById("show-route") as HTMLInputElement | null;
  if (routeToggle) {
    showRoute = localStorage.getItem("minigolf-ai:show-route") === "1";
    routeToggle.checked = showRoute;
    routeToggle.addEventListener("change", () => {
      showRoute = routeToggle.checked;
      localStorage.setItem("minigolf-ai:show-route", showRoute ? "1" : "0");
    });
  }

  requestAnimationFrame(frame);
}

async function loadMap(filename: string, resetAgent: boolean): Promise<void> {
  currentMapFile = filename;
  const text = await loadTrackByFile(filename);
  track = await loadTrack(text);
  renderer = createRenderer(track);
  if (statMap) statMap.textContent = track.name || "(unnamed)";

  // Each map has its own training config. Load it before creating the
  // agent so architectural knobs (gridSize, raySamples, hiddenSize) take
  // effect immediately. Auto-tune maxStrokes from the human community's
  // average strokes per play: floor of 30 (the static default), but
  // bump to 10× avg on harder maps where the human average exceeds 3.
  // The 10× headroom lets the agent recover from a few bad strokes
  // without immediately timing out. User-saved overrides still win.
  const meta = track.meta;
  const avgStrokes =
    meta.plays > 0 && meta.strokes > 0 ? meta.strokes / meta.plays : 0;
  const autoMaxStrokes = Math.max(30, Math.ceil(avgStrokes * 10));
  cfg = loadConfig(filename, { maxStrokes: autoMaxStrokes });

  recentReturns.length = 0;
  recentSuccesses.length = 0;
  bestStrokes = Infinity;
  episodeIndex = 0;
  lifetimeReturnsSum = 0;
  lifetimeReturnsCount = 0;
  perfected = false;
  lastSavedStatus = "";
  lastSavedBest = Infinity;
  chart?.reset();
  const perfEl = document.getElementById("map-stat-perfected");
  if (perfEl) perfEl.style.display = "none";

  if (resetAgent || !agent) {
    agent = new MLPAgent(cfg);
    console.log(
      `Actor-critic agent: ${agent.net.paramCount + agent.Wv.length + agent.bv.length} parameters, batchSize=${agent.batchSize}, γ=${agent.gamma}, gridSize=${cfg.gridSize}, raySamples=${cfg.raySamples}, hiddenSize=${cfg.hiddenSize}`,
    );
    setMode("training");
  } else {
    // Map switch without agent reset (rare path: only when the explicit
    // resetAgent flag is false). Apply non-architectural cfg fields live
    // so reward magnitudes / lr / γ track the new map's config.
    agent.updateLiveConfig(cfg);
  }
  // Reset bestActions for the new map; if a saved policy below has them,
  // they get restored after agent.loadSerialized.
  bestActions = null;
  agent.setMap(track.map);
  agent.setNavMap(track.pathDistMap.dist);

  // Try to restore a previously saved policy for this map. Loading happens
  // BEFORE setMap took effect on `agent.encodeState`, so we just call
  // setMap a second time defensively. The restored weights take precedence
  // over the freshly-initialised random ones.
  const saved = loadPolicy(filename);
  if (saved && agent.loadSerialized(saved)) {
    bestStrokes = saved.bestStrokes;
    lastSavedBest = saved.bestStrokes;
    lastSavedStatus = saved.status;
    // Restore visible counters so a refresh doesn't reset ep / success / etc.
    episodeIndex = saved.episodesTrained ?? 0;
    lifetimeReturnsSum = saved.lifetimeReturnsSum ?? 0;
    lifetimeReturnsCount = saved.episodesTrained ?? 0;
    if (saved.recentSuccesses) recentSuccesses.push(...saved.recentSuccesses);
    if (saved.recentReturns) {
      recentReturns.push(...saved.recentReturns);
      // Replay the saved per-episode returns into the chart so the
      // rolling-mean line resumes from where it left off rather than
      // starting flat at 0.
      for (const r of saved.recentReturns) chart?.push(r);
    }
    if (saved.bestActions) bestActions = saved.bestActions;
    console.log(
      `Loaded saved policy for ${filename}: best=${saved.bestStrokes}, status=${saved.status}, episodes=${saved.episodesTrained}`,
    );
    if (saved.status === "PERFECTED") {
      perfected = true;
      // Loaded perfected → default to "best" mode if we have a recorded
      // route, otherwise "eval". Either way, training stays paused.
      setMode(bestActions ? "best" : "eval");
      if (perfEl) perfEl.style.display = "";
    } else if (saved.status === "CONVERGED") {
      // Loaded converged → eval mode by default. Re-check against the
      // current convergence rule first, though: older saves were made
      // under a looser rule (success rate only, no par check), and an
      // old "CONVERGED" save may not meet the current bar. Loading
      // those into eval mode would freeze a sub-optimal policy
      // permanently. If the loaded state doesn't pass today's check,
      // fall back to training mode so the agent keeps improving.
      const loadedSuccess =
        recentSuccesses.length > 0
          ? recentSuccesses.reduce((a, b) => a + b, 0) / recentSuccesses.length
          : 0;
      const stillConverged = isConverged({
        success: loadedSuccess,
        lifetimeReturnsCount,
        recentSuccessCount: recentSuccesses.length,
        bestStrokes,
        par: track?.meta.bestPar ?? 0,
      });
      if (stillConverged) setMode("eval");
      else setMode("training");
    }
  }

  episodes = [];
  traces = [];
  for (let i = 0; i < cfg.numParallel; i++) {
    episodes.push(new Episode(track, { maxStrokes: cfg.maxStrokes, seed: i + 1 }));
    traces.push([]);
  }
  updateStatsPanel();
  updateMapStats();
  updateMetaPanel();
  refreshConfigPanel();

  // HIO pre-search: brute-force every shot on a polar grid and check
  // for a one-stroke hole. If found, we PERFECT immediately and skip
  // RL entirely - much faster than training a network on solvable maps.
  // Skipped when a saved policy already exists (we trust the user-
  // accumulated training over a re-search).
  if (
    cfg.searchHIOFirst > 0 &&
    !perfected &&
    !saved
  ) {
    void runHIOPreSearch(filename);
  }
}

/** Background HIO search. Captures the current `hioSearchGeneration` so
 *  if the user switches maps mid-search we discard the result. On
 *  success: persist as PERFECTED with the single-stroke route, flip the
 *  agent into "best" mode, show the perfect badge. On failure: nothing
 *  changes and RL keeps running. */
async function runHIOPreSearch(filename: string): Promise<void> {
  const myGen = ++hioSearchGeneration;
  hioSearchInProgress = true;
  if (statLast) statLast.textContent = "searching for hole-in-one...";
  // Reset and capture the overlay so each candidate can paint into it.
  // Cleared at the start of every search; rendered as a layer on the
  // stage canvas while the search is in flight.
  const overlay = ensureHioOverlay();
  clearHioOverlay();
  // Capture the start position once - all candidate shots fan from
  // the same ball position.
  const startBallX = track.startX;
  const startBallY = track.startY;
  const t0 = performance.now();
  const result = await searchHoleInOne(track, {
    onProgress: (done, total) => {
      if (myGen !== hioSearchGeneration) return; // user switched maps
      if (statLast) {
        const pct = ((done / total) * 100).toFixed(0);
        statLast.textContent = `HIO search ${pct}% (${done}/${total})`;
      }
    },
    onCandidate: (action, finalX, finalY, outcome) => {
      if (myGen !== hioSearchGeneration) return;
      paintHioCandidate(overlay.ctx, startBallX, startBallY, finalX, finalY, outcome);
    },
    isCancelled: () => myGen !== hioSearchGeneration,
  });
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  if (myGen !== hioSearchGeneration) {
    // A different map is loaded now; bail.
    return;
  }
  hioSearchInProgress = false;
  if (!result) {
    if (statLast) statLast.textContent = `no HIO found (${elapsed}s) — RL`;
    console.log(`HIO search exhausted on ${filename} in ${elapsed}s; RL takes over`);
    return;
  }
  console.log(
    `HIO found on ${filename} in ${elapsed}s: dx=${result.action.dx.toFixed(2)}, dy=${result.action.dy.toFixed(2)} (after ${result.candidatesTried} candidates)`,
  );
  // Adopt the HIO as the perfected route.
  bestStrokes = 1;
  bestActions = [result.action];
  perfected = true;
  setMode("best");
  const perfEl = document.getElementById("map-stat-perfected");
  if (perfEl) perfEl.style.display = "";

  // Persist as a PERFECTED save so a refresh skips the search next time.
  // We store the agent's current (untrained) weights - they're not the
  // source of the route, but the storage shape requires them.
  const data = agent.toSerialized();
  savePolicy({
    version: POLICY_VERSION,
    filename,
    bestStrokes: 1,
    status: "PERFECTED",
    episodesTrained: 0,
    savedAt: Date.now(),
    lifetimeReturnsSum: 0,
    recentSuccesses: [],
    recentReturns: [],
    bestActions: [result.action],
    ...data,
  });
  lastSavedStatus = "PERFECTED";
  lastSavedBest = 1;
  if (statLast) {
    statLast.textContent = `HIO found in ${elapsed}s 🏆`;
  }
  // Replace the in-flight episodes so they pick up the route on
  // their next stroke.
  episodes = [];
  traces = [];
  for (let i = 0; i < cfg.numParallel; i++) {
    episodes.push(new Episode(track, { maxStrokes: cfg.maxStrokes, seed: i + 1 }));
    traces.push([]);
  }
  updateStatsPanel();
  updateMapStats();
}

/**
 * Decide whether the just-finished episode warrants persisting the
 * network's current weights to localStorage. We save on any of:
 *
 *   - First time bestStrokes improves below `lastSavedBest` (anything
 *     that's better than the saved snapshot is worth keeping).
 *   - First entry into CONVERGED state (success rate ≥ 90%).
 *   - First time PERFECTED fires (already auto-freezes).
 *
 * The "lastSaved" trackers prevent re-saving the same milestone every
 * episode once we plateau.
 */
function maybePersistPolicy(holed: boolean): void {
  if (!currentMapFile || !agent) return;

  // Determine what tier of milestone we just hit.
  const success =
    recentSuccesses.length > 0
      ? recentSuccesses.reduce((a, b) => a + b, 0) / recentSuccesses.length
      : 0;
  let tier: SavedPolicy["status"] | null = null;
  if (perfected) tier = "PERFECTED";
  else if (
    isConverged({
      success,
      lifetimeReturnsCount,
      recentSuccessCount: recentSuccesses.length,
      bestStrokes,
      par: track?.meta.bestPar ?? 0,
    })
  ) tier = "CONVERGED";
  else if (holed && bestStrokes < lastSavedBest) tier = "BEST_IMPROVED";

  if (!tier) return;

  // Avoid re-saving the same tier with the same best repeatedly, but DO
  // refresh every 50 episodes so the persisted rolling-window stats stay
  // current with what's on screen (otherwise a long demo session shows
  // the same stale success rate / avg R after a refresh).
  const refreshInterval = 50;
  const dueForRefresh =
    tier === lastSavedStatus &&
    lifetimeReturnsCount > 0 &&
    lifetimeReturnsCount % refreshInterval === 0;
  if (
    tier === lastSavedStatus &&
    bestStrokes >= lastSavedBest &&
    !dueForRefresh
  ) return;

  const data = agent.toSerialized();
  const payload: SavedPolicy = {
    version: POLICY_VERSION,
    filename: currentMapFile,
    bestStrokes,
    status: tier,
    episodesTrained: lifetimeReturnsCount,
    savedAt: Date.now(),
    // Persist the rolling-window stats too so a refresh shows the same
    // success rate / avg R / chart that was on screen before.
    lifetimeReturnsSum,
    recentSuccesses: recentSuccesses.slice(),
    recentReturns: recentReturns.slice(),
    bestActions: bestActions ?? undefined,
    ...data,
  };
  savePolicy(payload);
  lastSavedStatus = tier;
  lastSavedBest = bestStrokes;
  console.log(
    `Saved policy for ${currentMapFile}: best=${bestStrokes}, tier=${tier}`,
  );
}

/**
 * Sample an action from the agent and (when `safetyRetries > 0`)
 * sandbox-simulate it before committing. If the simulation says the
 * ball would drown in water/acid, draw a fresh sample. After
 * `safetyRetries` rejections we give up and use the last sample - we'd
 * rather make a bad shot than burn unbounded compute.
 *
 * Eval mode is skipped: there's nothing to re-sample (the policy is
 * deterministic), so retrying would just produce the same action.
 */
function pickSafeAction(
  state: ReturnType<Episode["state"]>,
  ep: Episode,
  trace: PolicyStep[],
): { dx: number; dy: number } {
  const retries = cfg.safetyRetries;
  if (retries <= 0 || agent.evalMode) {
    return agent.actAndTrace(state, trace);
  }
  const learnFromRejected = cfg.learnFromRejectedShots > 0 && !agent.evalMode;
  let last = agent.sampleAction(state);
  for (let r = 0; r < retries; r++) {
    const outcome = ep.simulateShot(last.action);
    if (outcome !== "water" && outcome !== "acid") {
      agent.commitTraceStep(trace, last.step);
      return last.action;
    }
    // Rejected: feed it back as a single-sample policy gradient with
    // the synthetic water/acid penalty as the reward. This way the
    // policy actually learns "don't aim there", instead of relying on
    // the filter to censor those samples forever.
    if (learnFromRejected) {
      const syntheticReward =
        cfg.strokePenalty + (outcome === "acid" ? cfg.acidPenalty : cfg.waterPenalty);
      // Scale 1/safetyRetries: total rejection contribution per stroke
      // ≈ one accepted-step's gradient, regardless of how many retries
      // landed in water. Otherwise hard maps spam the gradient buffer
      // with rejection signal and destabilise training.
      const gradScale = 1.0 / Math.max(1, cfg.safetyRetries);
      agent.trainPolicyOnSample(last.step, syntheticReward, gradScale);
    }
    last = agent.sampleAction(state);
  }
  // All retries hit water/acid - commit the last try anyway so the
  // policy gets gradient signal from the resulting penalty.
  agent.commitTraceStep(trace, last.step);
  return last.action;
}

/** End episode i (credit it, push stats, train) and start a fresh one in
 *  its slot. Used both on natural termination and on btn-reset. */
function endAndReset(i: number) {
  const ep = episodes[i];
  if (!ep) return;
  const ret = episodeReturn(ep, cfg);

  // Only train in "training" mode. Eval and best modes pause the
  // weight updates entirely so switching is non-destructive.
  if (runMode === "training" && !agent.evalMode && traces[i].length > 0) {
    const stepReturns =
      agent.gamma >= 1
        ? new Array<number>(ep.strokes).fill(ret)
        : discountedPerStepReturns(ep, agent.gamma, cfg);
    agent.train(traces[i], stepReturns);
  }

  recentReturns.push(ret);
  if (recentReturns.length > RECENT_WINDOW) recentReturns.shift();
  const holed = ep.state().status === "holed";
  recentSuccesses.push(holed ? 1 : 0);
  if (recentSuccesses.length > RECENT_WINDOW) recentSuccesses.shift();
  if (holed && ep.strokes < bestStrokes) {
    bestStrokes = ep.strokes;
    // Capture this episode's actual sampled action sequence as the new
    // best route. Replayed by "best" mode and grid-view demo loops.
    bestActions = traces[i].map((s) => ({ dx: s.actionX, dy: s.actionY }));
  }

  lifetimeReturnsSum += ret;
  lifetimeReturnsCount += 1;

  // Hole-in-one auto-freeze. Once the agent achieves the optimal possible
  // result on a map there's nothing left to learn; further updates can
  // only push the policy off the perfect aim. Flip eval mode on and
  // reflect it in the UI.
  // Only crown PERFECTED when the agent holes in 1 with the *deterministic*
  // policy (evalMode already on). A noise-lucky hole-in-1 during training
  // wouldn't reliably reproduce, so demo playback would visibly miss.
  if (holed && ep.strokes === 1 && !perfected && agent.evalMode) {
    perfected = true;
    // Auto-switch to "best" mode (replays the recorded route deterministically).
    setMode(bestActions ? "best" : "eval");
    const perfEl = document.getElementById("map-stat-perfected");
    if (perfEl) perfEl.style.display = "";
  }

  if (statLast) {
    statLast.textContent = holed
      ? `holed in ${ep.strokes} (R=${ret})`
      : `failed (${ep.strokes}) (R=${ret})`;
  }
  chart?.push(ret);
  updateStatsPanel();
  updateMapStats();
  maybePersistPolicy(holed);

  episodeIndex++;
  episodes[i] = new Episode(track, { maxStrokes: cfg.maxStrokes, seed: episodeIndex + i });
  traces[i] = [];
}

/**
 * Refresh the map-stats footer below the chart. These are the LIFETIME
 * stats for the current map (since it was loaded), in contrast to the
 * header's "mean R(50)" rolling window. Lifetime average is more useful
 * for "how is this map going overall" / comparison across maps.
 */
/**
 * Render the original-database metadata for the current track. The .track
 * file format carries the per-map record holder, total plays, total
 * strokes, ratings, etc. - all data the original Playforia server tracked
 * for each map. We just expose it so users can compare the agent's
 * performance to the human community's.
 */
function updateMetaPanel() {
  if (!track) return;
  const m = track.meta;
  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("meta-author", m.author || "—");
  set("meta-plays", m.plays > 0 ? m.plays.toLocaleString() : "—");
  set("meta-strokes", m.strokes > 0 ? m.strokes.toLocaleString() : "—");
  if (m.plays > 0 && m.strokes > 0) {
    set("meta-avg-strokes", (m.strokes / m.plays).toFixed(2));
  } else {
    set("meta-avg-strokes", "—");
  }
  set("meta-par", m.bestPar > 0 ? `${m.bestPar} strokes` : "—");
  set("meta-par-count", m.numBestPar > 0 ? String(m.numBestPar) : "—");
  set("meta-record-holder", m.bestPlayer ?? "—");
  set("meta-record-date", m.bestParEpoch ? formatEpoch(m.bestParEpoch) : "—");
  set("meta-last-holder", m.lastBestPlayer ?? "—");
  set("meta-last-date", m.lastBestEpoch ? formatEpoch(m.lastBestEpoch) : "—");
  set("meta-cats", m.categories.length > 0 ? m.categories.join(", ") : "—");
  set("meta-settings", m.settings || "(none)");

  // Ratings histogram - 11 buckets. Each tracker file contains the count of
  // human ratings in each bucket; render as a normalised bar so very
  // popular maps and barely-played maps both visualise nicely.
  const ratingsEl = document.getElementById("meta-ratings");
  if (ratingsEl) {
    ratingsEl.innerHTML = "";
    const max = m.ratings.length > 0 ? Math.max(1, ...m.ratings) : 1;
    for (let i = 0; i < 11; i++) {
      const count = m.ratings[i] ?? 0;
      const h = Math.max(2, Math.round((count / max) * 30));
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.height = `${h}px`;
      bar.dataset.count = String(count);
      ratingsEl.appendChild(bar);
    }
  }
}

function formatEpoch(ms: number): string {
  // Most epochs in the .track files are in milliseconds; the format we get
  // back is YYYY-MM-DD. Some very old entries are in seconds - if the year
  // would land before 1990, we treat the value as seconds and re-multiply.
  let d = new Date(ms);
  if (d.getUTCFullYear() < 1990) d = new Date(ms * 1000);
  if (isNaN(d.getTime())) return "—";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function updateMapStats() {
  const elName = document.getElementById("map-stat-name");
  const elCount = document.getElementById("map-stat-count");
  const elAvg = document.getElementById("map-stat-avg");
  const elBest = document.getElementById("map-stat-best");
  const elStatus = document.getElementById("map-stat-status");
  if (elName) elName.textContent = track ? track.name || "(unnamed)" : "—";
  if (elCount) elCount.textContent = String(lifetimeReturnsCount);
  if (elAvg) {
    elAvg.textContent =
      lifetimeReturnsCount > 0
        ? (lifetimeReturnsSum / lifetimeReturnsCount).toFixed(2)
        : "—";
  }
  if (elBest) elBest.textContent = bestStrokes === Infinity ? "—" : String(bestStrokes);

  if (elStatus) {
    // Status badge: a coarse "how done is this map" indicator. Three soft
    // bands plus the hard "perfected" flag.
    //   training  → not enough data, or success rate still low
    //   converging → success rate is decent, policy is making progress
    //   converged → high success rate over a meaningful window
    //   perfected → hole-in-1 hit (auto-freeze fired)
    const success =
      recentSuccesses.length > 0
        ? recentSuccesses.reduce((a, b) => a + b, 0) / recentSuccesses.length
        : 0;
    let label: "TRAINING" | "CONVERGING" | "CONVERGED" | "PERFECTED" = "TRAINING";
    let cls: "training" | "converging" | "converged" | "perfected" = "training";
    if (perfected) {
      label = "PERFECTED";
      cls = "perfected";
    } else if (
      isConverged({
        success,
        lifetimeReturnsCount,
        recentSuccessCount: recentSuccesses.length,
        bestStrokes,
        par: track?.meta.bestPar ?? 0,
      })
    ) {
      label = "CONVERGED";
      cls = "converged";
    } else if (success >= 0.5) {
      label = "CONVERGING";
      cls = "converging";
    }
    elStatus.textContent = label;
    elStatus.className = `status ${cls}`;
  }
}

function updateStatsPanel() {
  const elBaseline = document.getElementById("stat-baseline");
  const elMean = document.getElementById("stat-mean");
  const elBest = document.getElementById("stat-best");
  const elSuccess = document.getElementById("stat-success");
  if (recentReturns.length === 0) {
    if (elMean) elMean.textContent = "—";
    if (elSuccess) elSuccess.textContent = "—";
    if (elBest) elBest.textContent = "—";
    if (elBaseline) elBaseline.textContent = agent ? agent.baseline.toFixed(2) : "—";
    return;
  }
  const meanRet =
    recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  const successPct =
    (recentSuccesses.reduce((a, b) => a + b, 0) / recentSuccesses.length) * 100;
  if (elBaseline) elBaseline.textContent = agent.baseline.toFixed(2);
  if (elMean) elMean.textContent = meanRet.toFixed(2);
  if (elBest) elBest.textContent = bestStrokes === Infinity ? "—" : String(bestStrokes);
  if (elSuccess) elSuccess.textContent = `${successPct.toFixed(0)}%`;
}

function frame(_time: number) {
  if (episodes.length === 0 || !renderer) {
    requestAnimationFrame(frame);
    return;
  }
  // Pause sim while the HIO pre-search is in progress. Otherwise the
  // agent burns cycles on a map we're about to confirm-perfect, and
  // its trace fills with rejected actions that don't match the eventual
  // policy. Render still runs so the user sees the map AND the live
  // overlay of attempted shots in `hioOverlayCanvas`.
  if (hioSearchInProgress) {
    renderer.render(stage!, episodes, { underlay: hioOverlayCanvas });
    requestAnimationFrame(frame);
    return;
  }

  // Single sim pass per rAF: each episode advances by `physicsPerFrame`
  // ticks, then we render. Higher slider = balls travel further between
  // renders; the apparent speed scales smoothly across the full range
  // with no abrupt cutoff.
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const state = ep.state();
    if (state.status === "holed" || state.status === "out_of_strokes") {
      endAndReset(i);
    } else if (state.status === "awaiting_shot") {
      // In "best" mode, replay the recorded best action sequence stroke-
      // by-stroke. Falls through to the agent if we ran out of recorded
      // actions (shouldn't happen — bestActions.length === bestStrokes
      // and physics is deterministic so we hole on the same step).
      let action;
      if (
        runMode === "best" &&
        bestActions &&
        ep.strokes < bestActions.length
      ) {
        action = bestActions[ep.strokes];
      } else {
        action = pickSafeAction(state, ep, traces[i]);
      }
      ep.applyShot(action);
    } else {
      ep.tick(physicsPerFrame);
    }
  }

  if (statEpisode) statEpisode.textContent = String(episodeIndex);
  if (statStrokes) statStrokes.textContent = String(episodes[0].strokes);

  // Always render. fps drops naturally at very high slider values
  // because the sim work fills the frame budget, but motion is continuous.
  const intents = episodes.map((ep) => {
    const s = ep.state();
    return s.status === "in_motion" || s.status === "awaiting_shot"
      ? agent.mean(s)
      : null;
  });
  const elSigma = document.getElementById("stat-sigma");
  if (elSigma) {
    const { sx, sy } = agent.currentMeanStd(episodes[0].state());
    elSigma.textContent = ((sx + sy) / 2).toFixed(1);
  }
  // Pathfinder route overlay: extract from ball-0's current position to
  // the hole. Recomputed every frame because the ball moves; cost is a
  // ~50-step downhill walk through a Int16Array - negligible.
  let route: Array<{ x: number; y: number }> | null = null;
  if (showRoute && track) {
    const s0 = episodes[0].state();
    route = extractRoute(track.pathDistMap, s0.ballX, s0.ballY);
  }
  renderer.render(stage!, episodes, { intents, route });
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Training-config UI.
//
// One <input> per knob, generated from the config schema. Architectural
// knobs (gridSize, raySamples, hiddenSize) trigger an agent rebuild for
// the current map - the network's input/weight shape depends on them, so
// we can't keep the saved policy. Live knobs apply to the running agent
// and are saved to localStorage immediately.
//
// Each row also shows the default in light text so the user knows what
// they're deviating from. A "reset to defaults" button restores all knobs
// for the current map in one click.
//
// Defined BEFORE `main()` is called so the async `loadMap` chain can call
// `refreshConfigPanel` without hitting a temporal-dead-zone error on the
// `cfgInputs` const.

interface ConfigRow {
  key: keyof TrainingConfig;
  label: string;
  /** Optional formatter (defaults to the raw number). Used for `lr` so
   *  scientific notation displays cleanly. */
  fmt?: (v: number) => string;
}

const CONFIG_GROUPS: Array<{ title: string; rows: ConfigRow[]; note?: string }> = [
  {
    title: "architecture",
    note: "changing these resets the agent for this map",
    rows: [
      { key: "gridSize",            label: "grid size (tiles)" },
      { key: "raySamples",          label: "ball→hole ray samples" },
      { key: "radialRays",          label: "radial rays (count)" },
      { key: "radialSamplesPerRay", label: "samples per radial ray" },
      { key: "useNavigation",       label: "navigation channel (0/1)" },
      { key: "hiddenSize",          label: "hidden neurons" },
    ],
  },
  {
    title: "spatial / safety",
    rows: [
      { key: "radialRayMaxDist",        label: "radial ray reach (px)" },
      { key: "safetyRetries",           label: "water/acid retry sample" },
      { key: "learnFromRejectedShots",  label: "learn from rejected shots (0/1)" },
      { key: "searchHIOFirst",          label: "brute-force HIO search (0/1)" },
    ],
  },
  {
    title: "optimizer",
    rows: [
      { key: "lr",        label: "learning rate", fmt: (v) => v.toExponential(2) },
      { key: "gamma",     label: "γ (discount)" },
      { key: "batchSize", label: "batch size (episodes)" },
      { key: "valueCoef", label: "value loss coef" },
      { key: "gradClip",  label: "gradient clip" },
    ],
  },
  {
    title: "action distribution",
    rows: [
      { key: "meanScale",  label: "mean scale (px)" },
      { key: "initLogStd", label: "initial log σ" },
      { key: "logStdMin",  label: "log σ min (clamp)" },
      { key: "logStdMax",  label: "log σ max (clamp)" },
    ],
  },
  {
    title: "reward",
    rows: [
      { key: "strokePenalty", label: "stroke penalty" },
      { key: "holeBonus",     label: "hole bonus" },
      { key: "waterPenalty",  label: "water penalty" },
      { key: "acidPenalty",   label: "acid penalty" },
      { key: "progressBonus",    label: "progress bonus (per px closer)" },
      { key: "explorationBonus", label: "exploration bonus (per px from start)" },
    ],
  },
  {
    title: "episode / runtime",
    rows: [
      { key: "maxStrokes",  label: "max strokes / episode" },
      { key: "numParallel", label: "parallel rollouts" },
    ],
  },
];

const cfgPanel = document.getElementById("training-config");
const cfgInputs = new Map<keyof TrainingConfig, HTMLInputElement>();

function renderConfigPanel(): void {
  if (!cfgPanel) return;
  cfgPanel.innerHTML = "";
  for (const group of CONFIG_GROUPS) {
    const wrap = document.createElement("div");
    wrap.className = "cfg-group";
    const h = document.createElement("h3");
    h.textContent = group.title;
    wrap.appendChild(h);
    if (group.note) {
      const note = document.createElement("p");
      note.className = "cfg-note";
      note.textContent = group.note;
      wrap.appendChild(note);
    }
    for (const row of group.rows) {
      const r = document.createElement("label");
      r.className = "cfg-row";
      const lbl = document.createElement("span");
      lbl.className = "cfg-label";
      lbl.textContent = row.label;
      const input = document.createElement("input");
      input.type = "number";
      const b = CONFIG_BOUNDS[row.key];
      input.min = String(b.min);
      input.max = String(b.max);
      input.step = String(b.step);
      input.dataset.key = row.key;
      input.value = String(cfg[row.key]);
      input.addEventListener("change", () => onConfigInputChange(row.key, input));
      const def = document.createElement("span");
      def.className = "cfg-default";
      const formatted = row.fmt ? row.fmt(CONFIG_DEFAULTS[row.key]) : String(CONFIG_DEFAULTS[row.key]);
      def.textContent = `default ${formatted}`;
      r.appendChild(lbl);
      r.appendChild(input);
      r.appendChild(def);
      wrap.appendChild(r);
      cfgInputs.set(row.key, input);
    }
    cfgPanel.appendChild(wrap);
  }
  const buttons = document.createElement("div");
  buttons.className = "cfg-buttons";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.textContent = "reset to defaults";
  resetBtn.addEventListener("click", () => {
    cfg = { ...CONFIG_DEFAULTS };
    saveConfig(currentMapFile, cfg);
    void loadMap(currentMapFile, /*resetAgent=*/ true);
  });
  buttons.appendChild(resetBtn);
  cfgPanel.appendChild(buttons);
}

function refreshConfigPanel(): void {
  if (cfgInputs.size === 0) return;
  for (const [key, input] of cfgInputs) {
    if (document.activeElement !== input) input.value = String(cfg[key]);
  }
}

function onConfigInputChange(key: keyof TrainingConfig, input: HTMLInputElement): void {
  const next = parseFloat(input.value);
  if (!Number.isFinite(next)) {
    input.value = String(cfg[key]);
    return;
  }
  const prev = cfg[key];
  cfg = { ...cfg, [key]: next };
  // Reflect any clamping (e.g. forcing odd grid sizes) back to the input.
  saveConfig(currentMapFile, cfg);
  // Reload to read back the clamped value into `cfg`.
  cfg = loadConfig(currentMapFile);
  if (document.activeElement !== input) input.value = String(cfg[key]);
  if (cfg[key] === prev) return; // no-op after clamping

  if ((ARCHITECTURE_KEYS as ReadonlyArray<keyof TrainingConfig>).includes(key)) {
    // Network shape changed - any loaded weights are now incompatible.
    void loadMap(currentMapFile, /*resetAgent=*/ true);
    return;
  }
  // Live knob: just push the new values into the running agent. The
  // next training batch picks them up.
  agent.updateLiveConfig(cfg);
  // numParallel and maxStrokes affect the rollout shape too. Easiest
  // way to apply them cleanly is to recreate the in-flight episodes.
  if (key === "numParallel" || key === "maxStrokes") {
    episodes = [];
    traces = [];
    for (let i = 0; i < cfg.numParallel; i++) {
      episodes.push(new Episode(track, { maxStrokes: cfg.maxStrokes, seed: episodeIndex + i + 1 }));
      traces.push([]);
    }
  }
}

renderConfigPanel();

main().catch((err) => {
  console.error("AI client failed to start:", err);
  if (statMap) statMap.textContent = "ERROR (see console)";
});
