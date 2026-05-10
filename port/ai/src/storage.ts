// Persistent storage for trained policies.
//
// We use localStorage (5-10 MB browser-wide, plenty for our ~98 KB per
// network) keyed by the .track filename. Each saved entry holds the
// serialised weight arrays plus enough metadata to display "you've solved
// this map in N strokes before, last trained Xh ago" info on load.
//
// Schema is versioned so we can evolve the network architecture later
// without crashing on legacy entries (loadPolicy returns null if the
// version doesn't match — caller falls back to a fresh agent).

// v1 → v2: input layer grew from 79 to 111 features (added 16-sample
// ball→hole ray). Reward now includes per-stroke water/acid penalties so
// the value head's old learning is also stale.
// v2 → v3: default config now adds radial rays (8 dirs × 4 samples = 64
// features), navigation channel (gridSize² extra features), and the
// default gridSize bumped 5→9. Net inputSize default jumped 111 → 343 →
// 424. Bumped so the handful of v2 trained policies don't silently
// orphan; they're reachable for inspection but loadPolicy returns null.
export const POLICY_VERSION = 3;
const PREFIX = "minigolf-ai:policy:v3:";

export interface SavedPolicy {
  version: typeof POLICY_VERSION;
  /** Filename of the .track this was trained on (also encoded in the key). */
  filename: string;
  /** Best strokes achieved (lower = better). */
  bestStrokes: number;
  /** Status at save time. We auto-save on CONVERGED and PERFECTED. */
  status: "CONVERGED" | "PERFECTED" | "BEST_IMPROVED";
  /** Lifetime episodes trained at save time - also used to seed the
   *  visible "ep" counter on reload so it doesn't reset to 0. */
  episodesTrained: number;
  /** Wall-clock millis when saved (for "trained 2h ago" displays). */
  savedAt: number;
  // Network weights, serialised as plain number arrays so JSON.stringify
  // works. Float32Array → Array.from gives us back JSON-safe floats.
  W1: number[];
  b1: number[];
  W2: number[];
  b2: number[];
  Wv: number[];
  bv: number[];
  /** Architecture sentinel - if these don't match the current network
   *  shape, the saved policy is incompatible and we discard it. */
  inputSize: number;
  hiddenSize: number;
  outputSize: number;
  // Persisted runtime stats - optional so older saves still load. These
  // restore the visible counters so a refresh doesn't blank out "success",
  // "avg R", lifetime episode count etc.
  lifetimeReturnsSum?: number;
  recentSuccesses?: number[];
  recentReturns?: number[];
  /** Recorded action sequence (mouse offsets per stroke) from the
   *  best-ever episode. Length = bestStrokes. Used by "best route"
   *  playback mode in the single-map view and by demo loops in the grid.
   *  Captures stochastic noise that achieved the best run, not the
   *  deterministic policy mean (which is rarely the best individual
   *  attempt). */
  bestActions?: Array<{ dx: number; dy: number }>;
}

export function savePolicy(p: SavedPolicy): void {
  try {
    localStorage.setItem(PREFIX + p.filename, JSON.stringify(p));
  } catch (e) {
    // QuotaExceededError or storage disabled (incognito etc).
    console.warn("Failed to save policy:", e);
  }
}

export function loadPolicy(filename: string): SavedPolicy | null {
  try {
    const raw = localStorage.getItem(PREFIX + filename);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedPolicy;
    if (parsed.version !== POLICY_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deletePolicy(filename: string): void {
  localStorage.removeItem(PREFIX + filename);
}

// ---------------------------------------------------------------------------
// Grid-map selection: which maps the user has chosen to display in the
// grid view. Persisted so the same set comes back across reloads.

const GRID_KEY = "minigolf-ai:grid-maps:v1";

export function saveGridMaps(files: string[]): void {
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify(files));
  } catch (e) {
    console.warn("Failed to save grid map selection:", e);
  }
}

export function loadGridMaps(): string[] | null {
  try {
    const raw = localStorage.getItem(GRID_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return null;
  }
}

/** Enumerate all saved policies (used by the grid view to show "X / N
 *  maps solved" progress). */
export function listSavedPolicies(): SavedPolicy[] {
  const out: SavedPolicy[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as SavedPolicy;
      if (parsed.version === POLICY_VERSION) out.push(parsed);
    } catch {
      // skip
    }
  }
  return out;
}
