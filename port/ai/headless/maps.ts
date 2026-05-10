// Eval map set (16 maps) - the loop scores against these every iteration.
// Held-out validation set (40 maps) - sanity-checked every 20 iterations
// to catch the case where the loop is overfitting to the eval 16.
//
// Selection rationale (per AUTORESEARCH_PLAN.md §4):
//
// All 56 maps were curated by running scripts/classify-tracks.mjs over every
// .track file in port/server/tracks/tracks/ (2062 maps). Each map is parsed
// via shared/track.ts, decoded via shared/rle.ts, and bucketed by inspecting
// the per-tile (special, shape) bytes plus the I-line bestPar / plays.
//
// Distribution targets (per category, eval | val):
//   easy       4 | 10  bestPar 1-2, no hazards, no teleports, no mines/magnets,
//                       plays >= 50k. Saturate-able for an HIO search.
//   hazard     4 | 10  hazards >= 30 background tiles (water/acid/swamp),
//                       no teleports. Tests the safety filter / acid-water
//                       penalty handling.
//   teleport   4 | 10  >=1 teleport start AND >=1 teleport exit. Tests the
//                       agent's ability to model non-Euclidean transitions.
//   hard       4 | 10  bestPar >= 4 (no teleport). The PAR is the BEST a
//                       human ever logged - "near-impossible" maps the
//                       agent shouldn't be expected to solve.
//
// Eval includes the maps already wired into the UI picker (CurveI, OvalI,
// BarbII) so the human's intuition for those scores carries over. Eval and
// validation are guaranteed disjoint.
//
// `par` is `track.bestPar` (the I-line 3rd field), the best stroke count
// any human has ever recorded for that map - a rough difficulty floor.

export interface EvalMap {
  file: string;
  category: "easy" | "hazard" | "teleport" | "hard";
  /** Author-provided par from the .track I line, when available. */
  par?: number;
}

export const EVAL_MAPS: ReadonlyArray<EvalMap> = [
  // --- easy: simple ovals/curves, no hazards. Should saturate quickly with HIO.
  { file: "CurveI.track", category: "easy", par: 1 },
  { file: "OvalI.track", category: "easy", par: 2 },
  { file: "1stroke4bounces.track", category: "easy", par: 1 },
  { file: "Leobas1.track", category: "easy", par: 2 },

  // --- hazard: water/acid blocks block much of the playing area.
  { file: "BarbII.track", category: "hazard", par: 2 },
  { file: "BarrierIII.track", category: "hazard", par: 2 },
  { file: "Wormhole.track", category: "hazard", par: 1 },
  { file: "LowerV.track", category: "hazard", par: 2 },

  // --- teleport: solving requires going through a teleport start.
  { file: "Miniaturica.track", category: "teleport", par: 1 },
  { file: "Reboundgoal.track", category: "teleport", par: 1 },
  { file: "Straight.track", category: "teleport", par: 1 },
  { file: "Withoneinhole.track", category: "teleport", par: 1 },

  // --- hard: bestPar >= 4. These are the "doesn't saturate" maps.
  { file: "VirtuosoBridges.track", category: "hard", par: 4 },
  { file: "Threehills.track", category: "hard", par: 5 },
  { file: "DreamofSixStrokes.track", category: "hard", par: 6 },
  { file: "Rood.track", category: "hard", par: 4 },
];

export const VALIDATION_MAPS: ReadonlyArray<EvalMap> = [
  // --- easy (10) ---
  { file: "RoomWorm.track", category: "easy", par: 1 },
  { file: "Downhill.track", category: "easy", par: 1 },
  { file: "Tooeasytoo.track", category: "easy", par: 1 },
  { file: "RemovableWall.track", category: "easy", par: 2 },
  { file: "Keepontrack.track", category: "easy", par: 1 },
  { file: "IceBounce.track", category: "easy", par: 1 },
  { file: "Gogogo.track", category: "easy", par: 1 },
  { file: "ArmChair.track", category: "easy", par: 1 },
  { file: "OvalIII.track", category: "easy", par: 2 },
  { file: "DarwinsroadII.track", category: "easy", par: 2 },

  // --- hazard (10) ---
  { file: "Smallisbeautiful.track", category: "hazard", par: 1 },
  { file: "Sandwall.track", category: "hazard", par: 2 },
  { file: "BarrierI.track", category: "hazard", par: 1 },
  { file: "Garapalou.track", category: "hazard", par: 3 },
  { file: "Astrolater.track", category: "hazard", par: 1 },
  { file: "3waystodoit.track", category: "hazard", par: 1 },
  { file: "Greenarrow.track", category: "hazard", par: 2 },
  { file: "Worm.track", category: "hazard", par: 1 },
  { file: "Wohwonk.track", category: "hazard", par: 1 },
  { file: "Waterpipe.track", category: "hazard", par: 1 },

  // --- teleport (10) ---
  { file: "Donatello.track", category: "teleport", par: 1 },
  { file: "JulyMorning.track", category: "teleport", par: 1 },
  { file: "ConjuringTrick.track", category: "teleport", par: 1 },
  { file: "DoubleFlipperTetris.track", category: "teleport", par: 1 },
  { file: "Lotto.track", category: "teleport", par: 1 },
  { file: "1shot.track", category: "teleport", par: 1 },
  { file: "Difficultchoice.track", category: "teleport", par: 1 },
  { file: "Mysteryofsmallarrow.track", category: "teleport", par: 1 },
  { file: "MoulinRouge.track", category: "teleport", par: 1 },
  { file: "Separated2.track", category: "teleport", par: 1 },

  // --- hard (10) ---
  { file: "SandStripe.track", category: "hard", par: 4 },
  { file: "RealPros7Strokes.track", category: "hard", par: 6 },
  { file: "Revocations.track", category: "hard", par: 4 },
  { file: "Jumptotheelevator.track", category: "hard", par: 5 },
  { file: "TripleCrossing.track", category: "hard", par: 5 },
  { file: "StonePassageRace.track", category: "hard", par: 6 },
  { file: "Sandland.track", category: "hard", par: 5 },
  { file: "WallsWaters.track", category: "hard", par: 5 },
  { file: "Keepturning.track", category: "hard", par: 6 },
  { file: "LockeddoorsII.track", category: "hard", par: 5 },
];
