// Ball physics — port of GameCanvas.run()'s inner loop. Ports more of the
// original mechanics:
//   - Slopes (4..11): per-substep directional acceleration
//   - Water/acid (12..15): when the ball stops on liquid, count up a 6-second
//     timer and respawn at start (water/swamp) or reset (acid/swamp).
//   - One-way walls (20..23): directional pass-through per tile id.
//   - Teleports (32..38 even): on touch, randomly pick an exit.
//   - Mines (28, 30): on contact, eject ball with random velocity.
//   - Magnets (44 attract, 45 repel): apply field force from precomputed map.

import { calculateFriction, PIXEL_PER_TILE, TILE_WIDTH, TILE_HEIGHT, type Seed } from "@minigolf/shared";
import { colAt, mutateTile, MAGNET_W, type ParsedMap } from "./map.ts";

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounciness: number;
  /** Magnet decay multiplier — Java's `somethingSpeedThing`. */
  magnetMul: number;
  onHole: boolean;
  onLiquidOrSwamp: boolean;
  /** Counts up while onHole or onLiquidOrSwamp. Java `onHoleTimer`. */
  liquidTimer: number;
  /** Where the ball was when the current stroke began (Java's tempCoordX/Y).
   *  This is the position water-event=0 ("restart from shot position") returns
   *  to — i.e., the player's last hit position. */
  strokeStartX: number;
  strokeStartY: number;
  /** Last "safe" (solid-ground) position during this stroke (Java's
   *  tempCoord2X/Y). Updated each iteration when the ball isn't on liquid /
   *  in a hole / influenced by magnets/slopes. Water-event=1 returns here. */
  shoreX: number;
  shoreY: number;
  /** Track teleport-cooldown per colour (so we don't infinitely re-teleport). */
  teleported: boolean;
  iterationsThisStroke: number;
  /** Per-ball stuck counters mirroring Java GameCanvas.run. Each one drops the
   *  corresponding force on this ball when the ball has been *slow* under that
   *  force for too many iterations — so a ball resting on a slope (or magnet,
   *  or hole rim) clears within ~1.5s instead of riding out the 9s safety cap. */
  downhillStuckCounter: number;
  magnetStuckCounter: number;
  spinningStuckCounter: number;
  stopped: boolean;
  inHole: boolean;
}

export interface PhysicsContext {
  map: ParsedMap;
  seed: Seed;
  norandom: boolean;
  /** Water-event setting from gameinfo. 0 = respawn at start, 1 = at last shore. */
  waterEvent: number;
  /** Pixel coords of the active start position (chosen by gameId %). */
  startX: number;
  startY: number;
  /**
   * Snapshot of OTHER players' resting pixel positions at the moment this
   * stroke's beginstroke broadcast was processed. Used by movable-block
   * obstruction checks (Java's `state.playerX/playerY` per-player loop).
   * `null` for any slot that's currently in motion or the shooter themselves
   * (they're skipped in the obstruction check).
   *
   * Snapshotting once per stroke keeps `canMovableBlockMove` deterministic
   * across clients even though local ball positions otherwise drift between
   * clients during async play.
   */
  otherPlayers: Array<{ x: number; y: number } | null>;
}

export function newBall(x: number, y: number): BallState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    bounciness: 1.0,
    magnetMul: 1.0,
    onHole: false,
    onLiquidOrSwamp: false,
    liquidTimer: 0,
    strokeStartX: x,
    strokeStartY: y,
    shoreX: x,
    shoreY: y,
    teleported: false,
    iterationsThisStroke: 0,
    downhillStuckCounter: 0,
    magnetStuckCounter: 0,
    spinningStuckCounter: 0,
    stopped: false,
    inHole: false,
  };
}

const MAGIC_OFFSET = Math.SQRT2 / 2;
const DIAG_OFFSET = Math.round(6 * MAGIC_OFFSET); // 4

/**
 * Wall-clock milliseconds per physics iteration. Java targets `6 * maxPhysicsIterations`
 * ms per outer loop with `maxPhysicsIterations` iterations inside it — so 6ms per
 * iteration regardless of the iteration batch size. We replicate that exact cadence
 * with a fixed accumulator in the RAF loop (see GamePanel.tick).
 */
export const PHYSICS_STEP_MS = 6;

/** Hard cap on a single stroke. 4000 iterations / 166 Hz ≈ 24 seconds — matches
 *  Java's `loopStuckCounter > 4000` first-tier safety threshold (GameCanvas.run
 *  line 445). Java zeroes bounciness at that point and gives the ball another
 *  3000 iterations to settle; we instead lean on the per-ball stuck counters
 *  (downhill/magnet/spinning) plus the `bounciness -= 0.01` per tile-18 hit
 *  decay (which drives super-bouncy back to static 0.84 within ~100 hits) to
 *  organically settle stuck strokes well before this cap. */
const MAX_STROKE_ITERATIONS = 4000;

/** Apply stroke impulse with deterministic noise — matches GameCanvas.doStroke.
 *  `shootingMode` mirrors the original right-click cycle: 0=normal, 1=reverse,
 *  2=90° clockwise, 3=90° counter-clockwise. Rotation is applied BEFORE the
 *  noise so each rotated direction has its own random branch — same order as
 *  Java's doStroke. */
export function applyStrokeImpulse(
  ball: BallState,
  ctx: PhysicsContext,
  mouseX: number,
  mouseY: number,
  shootingMode: number = 0,
): void {
  const dx = ball.x - mouseX;
  const dy = ball.y - mouseY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-9) return;
  let mag = (dist - 5) / 30;
  if (mag < 0.075) mag = 0.075;
  if (mag > 6.5) mag = 6.5;
  const scale = mag / dist;
  let vx = (mouseX - ball.x) * scale;
  let vy = (mouseY - ball.y) * scale;
  if (shootingMode === 1) {
    vx = -vx;
    vy = -vy;
  } else if (shootingMode === 2) {
    const t = vx;
    vx = vy;
    vy = -t;
  } else if (shootingMode === 3) {
    const t = vx;
    vx = -vy;
    vy = t;
  }
  const speed = Math.sqrt(vx * vx + vy * vy) / 6.5;
  const speed2 = speed * speed;
  if (!ctx.norandom) {
    vx += speed2 * ((ctx.seed.next() % 50001) / 100000 - 0.25);
    vy += speed2 * ((ctx.seed.next() % 50001) / 100000 - 0.25);
  }
  ball.vx = vx;
  ball.vy = vy;
  ball.bounciness = 1.0;
  ball.magnetMul = 1.0;
  ball.stopped = false;
  ball.onHole = false;
  ball.onLiquidOrSwamp = false;
  ball.liquidTimer = 0;
  ball.teleported = false;
  ball.iterationsThisStroke = 0;
  ball.downhillStuckCounter = 0;
  ball.magnetStuckCounter = 0;
  ball.spinningStuckCounter = 0;
  // Capture the position the ball had when this stroke began. Java's
  // tempCoordX/Y; water-event=0 returns here on water death.
  ball.strokeStartX = ball.x;
  ball.strokeStartY = ball.y;
  ball.shoreX = ball.x;
  ball.shoreY = ball.y;
}

/**
 * Center-in-tile test mirroring Java `Map.isPlayerAtPosition` (Map.java:315).
 * Pixel-precise: player is "at" tile (tx, ty) iff their CENTER is strictly
 * inside the tile's 15×15 footprint, with a 1-px exclusion on the +x/+y
 * edges (Java uses `< x*15 + 15 - 1`, not `<= x*15 + 15`). NOT a radius
 * overlap — Java doesn't account for the ball's sprite size here.
 */
function ballOnTile(tx: number, ty: number, px: number, py: number): boolean {
  const x0 = tx * PIXEL_PER_TILE;
  const y0 = ty * PIXEL_PER_TILE;
  return (
    px > x0 && px < x0 + PIXEL_PER_TILE - 1 &&
    py > y0 && py < y0 + PIXEL_PER_TILE - 1
  );
}

/**
 * Whether a movable block at (tx, ty) can slide into the destination tile.
 * Returns the destination tile's background id (so the caller can decide
 * if the block keeps sliding on a downhill), or -1 if the destination is
 * not empty / contains a player.
 *
 * Mirrors Java `Map.canMovableBlockMove`: the destination must have
 * `special === 1`, `shape === 0`, `bg <= 15` (no walls / specials), and no
 * player ball overlapping it.
 */
function canMovableBlockMove(
  map: ParsedMap,
  tx: number,
  ty: number,
  others: Array<{ x: number; y: number } | null>,
): number {
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) return -1;
  const code = map.tiles[tx][ty];
  const special = (code >>> 24) & 0xff;
  const shape = (code >>> 16) & 0xff;
  const bg = (code >>> 8) & 0xff;
  if (special !== 1 || shape !== 0 || bg > 15) return -1;
  for (const p of others) {
    if (!p) continue;
    if (ballOnTile(tx, ty, p.x, p.y)) return -1;
  }
  return bg;
}

/**
 * Recursively follow a sunkable block (shape 46) down a chain of downhill
 * tiles until it either rests on flat ground or hits an obstruction. Returns
 * `[finalTx, finalTy, finalBg]`. Mirrors Java's
 * `calculateMovableBlockEndPosition` — same i<1078 recursion cap, same gate
 * `!nonSunkable && background1 in 4..11`, so non-sunkable shape 27 always
 * stops after the first slide step.
 */
function calculateMovableBlockEndPosition(
  map: ParsedMap,
  toTx: number,
  toTy: number,
  toBg: number,
  nonSunkable: boolean,
  depth: number,
  others: Array<{ x: number; y: number } | null>,
): [number, number, number] {
  let result: [number, number, number] = [toTx, toTy, toBg];
  if (!nonSunkable && toBg >= 4 && toBg <= 11 && depth < 1078) {
    let nextTx = toTx;
    let nextTy = toTy;
    // Direction by downhill code (4=N, 5=NE, 6=E, 7=SE, 8=S, 9=SW, 10=W, 11=NW).
    if (toBg === 4 || toBg === 5 || toBg === 11) nextTy--;
    if (toBg === 8 || toBg === 7 || toBg === 9) nextTy++;
    if (toBg === 5 || toBg === 6 || toBg === 7) nextTx++;
    if (toBg === 9 || toBg === 10 || toBg === 11) nextTx--;
    const nextBg = canMovableBlockMove(map, nextTx, nextTy, others);
    if (nextBg >= 0) {
      result = calculateMovableBlockEndPosition(
        map, nextTx, nextTy, nextBg, nonSunkable, depth + 1, others,
      );
    }
  }
  return result;
}

/**
 * Try to push a movable block at tile (blockTx, blockTy) one step in
 * direction (dx, dy) (each ±1 or 0). Mutates the map in place: clears the
 * source tile to bare floor, places the block at its rest position, and
 * (for sunkable blocks ending on water/acid) flips it to the sunken
 * silhouette.
 *
 * Returns true if the block actually moved (caller uses this to switch the
 * ball's restitution from 0.8 → 0.325, matching Java getSpeedEffect).
 */
function handleMovableBlock(
  map: ParsedMap,
  blockTx: number,
  blockTy: number,
  dx: number,
  dy: number,
  nonSunkable: boolean,
  others: Array<{ x: number; y: number } | null>,
): boolean {
  if (blockTx < 0 || blockTx >= TILE_WIDTH || blockTy < 0 || blockTy >= TILE_HEIGHT) {
    return false;
  }
  const code = map.tiles[blockTx][blockTy];
  const special = (code >>> 24) & 0xff;
  const shape = (code >>> 16) & 0xff; // shapeReduced (Java's `shape` is +24)
  const bg = (code >>> 8) & 0xff;
  // Validate it really is a live movable block. The collision pixel may have
  // been a 27/46 even if a previous push has since cleared the source — bail
  // unless the tile-data still says it's there.
  const fullShape = shape + 24;
  if (special !== 2 || (fullShape !== 27 && fullShape !== 46)) return false;

  const destTx = blockTx + dx;
  const destTy = blockTy + dy;
  const destBg = canMovableBlockMove(map, destTx, destTy, others);
  if (destBg === -1) return false;

  // Clear source tile to empty floor with the original background.
  // 16777216 = (1 << 24): special=1, shape=0, fg=0.
  mutateTile(map, blockTx, blockTy, 16777216 + bg * 256);

  const [finalTx, finalTy, finalBg] = calculateMovableBlockEndPosition(
    map, destTx, destTy, destBg, nonSunkable, 0, others,
  );

  if (!nonSunkable && (finalBg === 12 || finalBg === 13)) {
    // Sunken: special=2, shapeReduced=23 (shape 47), fg=0, bg=water/acid.
    // 35061760 = (2 << 24) | (23 << 16).
    mutateTile(map, finalTx, finalTy, 35061760 + finalBg * 256);
  } else {
    // Place block at its rest tile preserving the destination background.
    // 33554432 = (2 << 24); shapeReduced is 3 for shape 27, 22 for shape 46.
    const shapeReduced = (nonSunkable ? 27 : 46) - 24;
    mutateTile(map, finalTx, finalTy, 33554432 + shapeReduced * 256 * 256 + finalBg * 256);
  }
  return true;
}

/**
 * Decay one step of a breakable brick (40..43) at tile (tx, ty). Mirrors Java
 * `GameCanvas.handleBreakableBlock`: each hit bumps the shape one notch
 * (40 → 41 → 42 → 43); a fourth hit replaces the tile with bare floor carrying
 * the original background colour. The mutation flows through `mutateTile`, so
 * the renderer's dirty-tile drain picks it up next frame.
 */
function handleBreakableBlock(map: ParsedMap, tx: number, ty: number): void {
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) return;
  const code = map.tiles[tx][ty];
  const special = (code >>> 24) & 0xff;
  const shape = (code >>> 16) & 0xff; // shapeReduced; brick range is 16..19
  const bg = (code >>> 8) & 0xff;
  const fg = code & 0xff;
  if (special !== 2 || shape < 16 || shape > 19) return;
  if (shape < 19) {
    // Next decay step. 33554432 = (2 << 24).
    mutateTile(map, tx, ty, 33554432 + (shape + 1) * 256 * 256 + bg * 256 + fg);
  } else {
    // Final hit on shape 43 → empty floor with original bg as both bg and fg.
    // 16777216 = (1 << 24).
    mutateTile(map, tx, ty, 16777216 + bg * 256 + bg);
  }
}

function isWall(v: number): boolean {
  // 16..23 except 19, plus 27, 40..43, 46. Per handleWallCollision.
  if (v >= 16 && v <= 23 && v !== 19) return true;
  if (v === 27) return true;
  if (v >= 40 && v <= 43) return true;
  if (v === 46) return true;
  return false;
}

/**
 * Bounce coefficient for a wall collision — applied as a multiplier on the
 * reflected velocity component. For bouncy blocks (18) the coefficient is
 * dynamic and CAN exceed 1.0 (super-bouncy), accelerating slow balls toward
 * ~6.5 units while decaying with each hit. Mirrors Java getSpeedEffect.
 */
function getRestitution(v: number, ball: BallState): number {
  if (v === 16) return 0.81;
  if (v === 17) return 0.05;
  if (v === 18) {
    if (ball.bounciness <= 0) return 0.84;
    ball.bounciness -= 0.01;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed < 0.001) return 0.84;
    return (ball.bounciness * 6.5) / speed;
  }
  if (v === 27 || v === 46) return 0.8;
  if (v >= 40 && v <= 43) return 0.9;
  if (v >= 20 && v <= 23) return 0.82;
  return 1.0;
}

interface Neighbors {
  c: number;
  t: number;
  tr: number;
  r: number;
  br: number;
  b: number;
  bl: number;
  l: number;
  tl: number;
}

function readNeighbors(map: ParsedMap, x: number, y: number): Neighbors {
  return {
    c: colAt(map, x, y),
    t: colAt(map, x, y - 6),
    tr: colAt(map, x + DIAG_OFFSET, y - DIAG_OFFSET),
    r: colAt(map, x + 6, y),
    br: colAt(map, x + DIAG_OFFSET, y + DIAG_OFFSET),
    b: colAt(map, x, y + 6),
    bl: colAt(map, x - DIAG_OFFSET, y + DIAG_OFFSET),
    l: colAt(map, x - 6, y),
    tl: colAt(map, x - DIAG_OFFSET, y - DIAG_OFFSET),
  };
}

/**
 * Compute restitution for a wall hit, AND if the wall happens to be a
 * movable/sunkable block (27/46) try to push it. Block-push uses the
 * same per-edge offset Java's `getSpeedEffect` does: dx/dy point from the
 * ball's centre to the neighbour we just sampled, and the block slides
 * one tile further in that direction.
 *
 * The collision pixel may not always be in the block's tile (e.g. the ball
 * grazes a wall pixel that belongs to the neighbouring tile due to mask
 * shape) — `handleMovableBlock` validates the tile-data and bails if it
 * isn't a real block tile, which keeps us correct for those edge cases.
 */
function bounceCoeff(
  ball: BallState,
  ctx: PhysicsContext,
  v: number,
  ix: number,
  iy: number,
  sampleDx: number,
  sampleDy: number,
  unitDx: number,
  unitDy: number,
): number {
  if (v === 27 || v === 46) {
    const blockTx = Math.floor((ix + sampleDx) / PIXEL_PER_TILE);
    const blockTy = Math.floor((iy + sampleDy) / PIXEL_PER_TILE);
    const moved = handleMovableBlock(
      ctx.map, blockTx, blockTy, unitDx, unitDy, v === 27, ctx.otherPlayers,
    );
    return moved ? 0.325 : 0.8;
  }
  if (v >= 40 && v <= 43) {
    const blockTx = Math.floor((ix + sampleDx) / PIXEL_PER_TILE);
    const blockTy = Math.floor((iy + sampleDy) / PIXEL_PER_TILE);
    handleBreakableBlock(ctx.map, blockTx, blockTy);
  }
  return getRestitution(v, ball);
}

/**
 * Wall collision — port of GameCanvas.handleWallCollision (lines 1205-1451).
 * Includes one-way wall (20-23) directional pass-through.
 */
function handleWallCollision(ball: BallState, ctx: PhysicsContext, n: Neighbors, ix: number, iy: number): void {
  let top = isWall(n.t);
  let right = isWall(n.r);
  let bottom = isWall(n.b);
  let left = isWall(n.l);
  let tr = isWall(n.tr);
  let br = isWall(n.br);
  let bl = isWall(n.bl);
  let tl = isWall(n.tl);

  // One-way wall pass-through. 20=N (no top hit), 21=E (no right hit),
  // 22=S (no bottom hit), 23=W (no left hit) — per Java GameCanvas:1244-1322.
  if (top && n.t === 20) top = false;
  if (tl && n.tl === 20) tl = false;
  if (tr && n.tr === 20) tr = false;
  if (left && n.l === 20) left = false;
  if (right && n.r === 20) right = false;

  if (right && n.r === 21) right = false;
  if (tr && n.tr === 21) tr = false;
  if (br && n.br === 21) br = false;
  if (top && n.t === 21) top = false;
  if (bottom && n.b === 21) bottom = false;

  if (bottom && n.b === 22) bottom = false;
  if (br && n.br === 22) br = false;
  if (bl && n.bl === 22) bl = false;
  if (right && n.r === 22) right = false;
  if (left && n.l === 22) left = false;

  if (left && n.l === 23) left = false;
  if (bl && n.bl === 23) bl = false;
  if (tl && n.tl === 23) tl = false;
  if (bottom && n.b === 23) bottom = false;
  if (top && n.t === 23) top = false;

  // Inside-corner suppression — match Java:1324-1362.
  if (top && tr && right && (n.t < 20 || n.t > 23) && (n.tr < 20 || n.tr > 23) && (n.r < 20 || n.r > 23)) {
    right = false;
    top = false;
  }
  if (right && br && bottom && (n.r < 20 || n.r > 23) && (n.br < 20 || n.br > 23) && (n.b < 20 || n.b > 23)) {
    bottom = false;
    right = false;
  }
  if (bottom && bl && left && (n.b < 20 || n.b > 23) && (n.bl < 20 || n.bl > 23) && (n.l < 20 || n.l > 23)) {
    left = false;
    bottom = false;
  }
  if (left && tl && top && (n.l < 20 || n.l > 23) && (n.tl < 20 || n.tl > 23) && (n.t < 20 || n.t > 23)) {
    top = false;
    left = false;
  }

  if (!top && !right && !bottom && !left) {
    let temp: number;
    if (
      tr &&
      ((ball.vx > 0 && ball.vy < 0) ||
        (ball.vx < 0 && ball.vy < 0 && -ball.vy > -ball.vx) ||
        (ball.vx > 0 && ball.vy > 0 && ball.vx > ball.vy))
    ) {
      const e = bounceCoeff(ball, ctx, n.tr, ix, iy, DIAG_OFFSET, -DIAG_OFFSET, 1, -1);
      temp = ball.vx;
      ball.vx = ball.vy * e;
      ball.vy = temp * e;
      return;
    }
    if (
      br &&
      ((ball.vx > 0 && ball.vy > 0) ||
        (ball.vx > 0 && ball.vy < 0 && ball.vx > -ball.vy) ||
        (ball.vx < 0 && ball.vy > 0 && ball.vy > -ball.vx))
    ) {
      const e = bounceCoeff(ball, ctx, n.br, ix, iy, DIAG_OFFSET, DIAG_OFFSET, 1, 1);
      temp = ball.vx;
      ball.vx = -ball.vy * e;
      ball.vy = -temp * e;
      return;
    }
    if (
      bl &&
      ((ball.vx < 0 && ball.vy > 0) ||
        (ball.vx > 0 && ball.vy > 0 && ball.vy > ball.vx) ||
        (ball.vx < 0 && ball.vy < 0 && -ball.vx > -ball.vy))
    ) {
      const e = bounceCoeff(ball, ctx, n.bl, ix, iy, -DIAG_OFFSET, DIAG_OFFSET, -1, 1);
      temp = ball.vx;
      ball.vx = ball.vy * e;
      ball.vy = temp * e;
      return;
    }
    if (
      tl &&
      ((ball.vx < 0 && ball.vy < 0) ||
        (ball.vx < 0 && ball.vy > 0 && -ball.vx > ball.vy) ||
        (ball.vx > 0 && ball.vy < 0 && -ball.vy > ball.vx))
    ) {
      const e = bounceCoeff(ball, ctx, n.tl, ix, iy, -DIAG_OFFSET, -DIAG_OFFSET, -1, -1);
      temp = ball.vx;
      ball.vx = -ball.vy * e;
      ball.vy = -temp * e;
    }
    return;
  }

  if (top && ball.vy < 0) {
    const e = bounceCoeff(ball, ctx, n.t, ix, iy, 0, -6, 0, -1);
    ball.vx *= e;
    ball.vy *= -e;
  } else if (bottom && ball.vy > 0) {
    const e = bounceCoeff(ball, ctx, n.b, ix, iy, 0, 6, 0, 1);
    ball.vx *= e;
    ball.vy *= -e;
  }
  if (right && ball.vx > 0) {
    const e = bounceCoeff(ball, ctx, n.r, ix, iy, 6, 0, 1, 0);
    ball.vx *= -e;
    ball.vy *= e;
    return;
  }
  if (left && ball.vx < 0) {
    const e = bounceCoeff(ball, ctx, n.l, ix, iy, -6, 0, -1, 0);
    ball.vx *= -e;
    ball.vy *= e;
  }
}

/** Slope acceleration — values 4..11, 8 directions. Java handleDownhill. */
function handleDownhill(ball: BallState, centerVal: number): boolean {
  if (centerVal < 4 || centerVal > 11) return false;
  const a = 0.025;
  switch (centerVal) {
    case 4: ball.vy -= a; break;
    case 5: ball.vy -= a * MAGIC_OFFSET; ball.vx += a * MAGIC_OFFSET; break;
    case 6: ball.vx += a; break;
    case 7: ball.vy += a * MAGIC_OFFSET; ball.vx += a * MAGIC_OFFSET; break;
    case 8: ball.vy += a; break;
    case 9: ball.vy += a * MAGIC_OFFSET; ball.vx -= a * MAGIC_OFFSET; break;
    case 10: ball.vx -= a; break;
    case 11: ball.vy -= a * MAGIC_OFFSET; ball.vx -= a * MAGIC_OFFSET; break;
    default: return false;
  }
  return true;
}

/** Hole-pull (8-direction force toward centre), lock if 7+ neighbours are hole. */
function handleHolePull(
  ball: BallState,
  n: Neighbors,
  map: ParsedMap,
  ix: number,
  iy: number,
): boolean {
  const HOLE = 25;
  const trigger =
    n.c === HOLE ||
    colAt(map, ix, iy - 1) === HOLE ||
    colAt(map, ix + 1, iy) === HOLE ||
    colAt(map, ix, iy + 1) === HOLE ||
    colAt(map, ix - 1, iy) === HOLE;
  if (!trigger) return false;

  const holeSpeed = n.c === HOLE ? 1.0 : 0.5;
  let counter = 0;
  if (n.t === HOLE) counter++;
  else ball.vy += holeSpeed * 0.03;
  if (n.tr === HOLE) counter++;
  else {
    ball.vy += holeSpeed * 0.03 * MAGIC_OFFSET;
    ball.vx -= holeSpeed * 0.03 * MAGIC_OFFSET;
  }
  if (n.r === HOLE) counter++;
  else ball.vx -= holeSpeed * 0.03;
  if (n.br === HOLE) counter++;
  else {
    ball.vy -= holeSpeed * 0.03 * MAGIC_OFFSET;
    ball.vx -= holeSpeed * 0.03 * MAGIC_OFFSET;
  }
  if (n.b === HOLE) counter++;
  else ball.vy -= holeSpeed * 0.03;
  if (n.bl === HOLE) counter++;
  else {
    ball.vy -= holeSpeed * 0.03 * MAGIC_OFFSET;
    ball.vx += holeSpeed * 0.03 * MAGIC_OFFSET;
  }
  if (n.l === HOLE) counter++;
  else ball.vx += holeSpeed * 0.03;
  if (n.tl === HOLE) counter++;
  else {
    ball.vy += holeSpeed * 0.03 * MAGIC_OFFSET;
    ball.vx += holeSpeed * 0.03 * MAGIC_OFFSET;
  }

  if (counter >= 7) {
    ball.vx = 0;
    ball.vy = 0;
    ball.onHole = true;
    return false;
  }
  return true;
}

/** Teleport when ball is adjacent to a teleport-start tile. Java handleTeleport. */
function handleTeleport(ball: BallState, ctx: PhysicsContext, n: Neighbors, ix: number, iy: number): void {
  let foundColour = -1;
  for (let id = 32; id <= 38; id += 2) {
    if (
      n.t === id || n.tr === id || n.r === id || n.br === id ||
      n.b === id || n.bl === id || n.l === id || n.tl === id
    ) {
      foundColour = (id - 32) / 2;
      break;
    }
  }
  if (foundColour < 0) {
    ball.teleported = false;
    return;
  }
  if (ball.teleported) return; // already teleported this contact
  ball.teleported = true;

  const exits = ctx.map.teleportExits[foundColour];
  if (exits.length > 0) {
    const idx = ctx.seed.next() % exits.length;
    const e = exits[idx];
    ball.x = e[0];
    ball.y = e[1];
    return;
  }
  // No exit — pick a random other-coloured exit, or another start.
  const starts = ctx.map.teleportStarts[foundColour];
  if (starts.length >= 2) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const idx = ctx.seed.next() % starts.length;
      const s = starts[idx];
      if (Math.abs(s[0] - ix) >= 15 || Math.abs(s[1] - iy) >= 15) {
        ball.x = s[0];
        ball.y = s[1];
        return;
      }
    }
    return;
  }
  for (let i = 0; i < 4; i++) {
    if (ctx.map.teleportExits[i].length > 0) {
      // Pick a random colour with exits.
      let colour = ctx.seed.next() % 4;
      while (ctx.map.teleportExits[colour].length === 0) {
        colour = ctx.seed.next() % 4;
      }
      const ex = ctx.map.teleportExits[colour];
      const idx = ctx.seed.next() % ex.length;
      ball.x = ex[idx][0];
      ball.y = ex[idx][1];
      return;
    }
  }
}

/**
 * Mine detonation (28 / 30): mutate the tile so it can't retrigger, optionally
 * dig a crater for big mines, then eject the ball with a random velocity in
 * [5.2, 6.5] magnitude. Mirrors Java GameCanvas.handleMines.
 */
function handleMine(ball: BallState, ctx: PhysicsContext, ix: number, iy: number, isBigMine: boolean): void {
  const map = ctx.map;
  const tx = (ix / 15) | 0;
  const ty = (iy / 15) | 0;
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) return;
  const code = map.tiles[tx][ty];
  const special = (code >>> 24) & 0xff;
  const shape = (code >>> 16) & 0xff; // shapeReduced; 4 = small mine, 6 = big mine
  const bg = (code >>> 8) & 0xff;
  const fg = code & 0xff;
  if (special !== 2 || (shape !== 4 && shape !== 6)) return;

  // Java handleMines encodes `foreground * 256 + background` here, which swaps
  // the bg/fg byte order versus every other mutate call (e.g. handleBreakableBlock
  // uses `background * 256 + foreground`). Reproduce the swap for replay parity.
  mutateTile(map, tx, ty, 33554432 + (shape + 1) * 256 * 256 + fg * 256 + bg);

  if (isBigMine) {
    // 9-tile crater: surrounding empty-grass tiles (code === 16777216) are
    // replaced with downhill slopes pointing away from the mine. Tiles that
    // are anything else (walls, water, other specials) are left untouched.
    const downhills = [17039367, 16779264, 17104905, 16778752, -1, 16779776, 17235973, 16778240, 17170443];
    let tileIndex = 0;
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) {
        if (
          x >= 0 && x < TILE_WIDTH && y >= 0 && y < TILE_HEIGHT &&
          (y !== ty || x !== tx) &&
          map.tiles[x][y] === 16777216
        ) {
          mutateTile(map, x, y, downhills[tileIndex]);
        }
        tileIndex++;
      }
    }
  }

  // Reroll vx/vy until the magnitude is in the [5.2, 6.5] annulus. Java's loop
  // is unbounded; acceptance probability per attempt is ~28%, so a cap risks
  // breaking determinism without preventing any practical infinite loop.
  let speed: number;
  do {
    ball.vx = (-65 + (ctx.seed.next() % 131)) / 10;
    ball.vy = (-65 + (ctx.seed.next() % 131)) / 10;
    speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  } while (speed < 5.2 || speed > 6.5);

  if (!isBigMine) {
    ball.vx *= 0.8;
    ball.vy *= 0.8;
  }
}

/** Magnet field force per Java handleMagnetForce. */
function handleMagnet(ball: BallState, ctx: PhysicsContext, ix: number, iy: number): boolean {
  const map = ctx.map.magnetMap;
  if (!map) return false;
  const cx = (ix / 5) | 0;
  const cy = (iy / 5) | 0;
  if (cx < 0 || cx >= MAGNET_W || cy < 0 || cy >= 75) return false;
  const o = (cy * MAGNET_W + cx) * 2;
  const fx = map[o];
  const fy = map[o + 1];
  if (fx === 0 && fy === 0) return false;
  if (ball.magnetMul > 0) ball.magnetMul -= 1.0e-4;
  ball.vx += ball.magnetMul * fx * 5.0e-4;
  ball.vy += ball.magnetMul * fy * 5.0e-4;
  return true;
}

function resetToStart(ball: BallState, ctx: PhysicsContext): void {
  ball.x = ctx.startX;
  ball.y = ctx.startY;
  ball.vx = 0;
  ball.vy = 0;
  ball.shoreX = ctx.startX;
  ball.shoreY = ctx.startY;
}

export interface StepResult {
  stopped: boolean;
  inHole: boolean;
}

/**
 * Run exactly ONE physics iteration: 10 substeps with collision/teleport/mine
 * handling, then one application of slope, magnet, hole-pull, friction, and
 * stop/death checks. The caller drives this at a fixed 166 Hz to match Java.
 */
export function step(ball: BallState, ctx: PhysicsContext): StepResult {
  if (ball.stopped || ball.inHole) {
    return { stopped: true, inHole: ball.inHole };
  }
  const map = ctx.map;

  {
    let stoppedThisIter = false;
    let centerVal = 0;
    let onLiquid = false;

    for (let j = 0; j < 10; j++) {
      ball.x += ball.vx * 0.1;
      ball.y += ball.vy * 0.1;
      if (ball.x < 6.6) ball.x = 6.6;
      if (ball.x >= 727.9) ball.x = 727.9;
      if (ball.y < 6.6) ball.y = 6.6;
      if (ball.y >= 367.9) ball.y = 367.9;

      const ix = (ball.x + 0.5) | 0;
      const iy = (ball.y + 0.5) | 0;
      const n = readNeighbors(map, ix, iy);
      centerVal = n.c;

      if (n.c === 12 || n.c === 13) {
        ball.vx *= 0.97;
        ball.vy *= 0.97;
        onLiquid = true;
      } else if (n.c === 14 || n.c === 15) {
        onLiquid = true;
      }

      // Teleport check (8-direction adjacency).
      handleTeleport(ball, ctx, n, ix, iy);

      // Mines: centre on a mine tile triggers detonation.
      if (n.c === 28 || n.c === 30) {
        handleMine(ball, ctx, ix, iy, n.c === 30);
      }

      handleWallCollision(ball, ctx, n, ix, iy);
    }

    const ix = (ball.x + 0.5) | 0;
    const iy = (ball.y + 0.5) | 0;
    const n = readNeighbors(map, ix, iy);

    let isDownhill = handleDownhill(ball, centerVal);
    let isMagnet = !onLiquid && !ball.onHole && !ball.onLiquidOrSwamp
      ? handleMagnet(ball, ctx, ix, iy)
      : false;

    let spinning = false;
    if (!ball.onHole) {
      spinning = handleHolePull(ball, n, map, ix, iy);
    }

    // Spinning-stuck gate (Java GameCanvas.run line 411-418): if the ball has
    // been hovering on a hole rim for >500 iterations, drop the hole pull so
    // friction can settle it.
    if (spinning) {
      ball.spinningStuckCounter++;
      if (ball.spinningStuckCounter > 500) {
        spinning = false;
      }
    } else {
      ball.spinningStuckCounter = 0;
    }

    // Track shore (last solid-ground position) for water-shore respawn.
    if (!isDownhill && !isMagnet && !spinning && !ball.onHole && !ball.onLiquidOrSwamp && !onLiquid) {
      ball.shoreX = ball.x;
      ball.shoreY = ball.y;
    }

    // Friction.
    let speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed > 0) {
      const f = calculateFriction(centerVal, speed);
      ball.vx *= f;
      ball.vy *= f;
      speed *= f;
      if (speed > 7.0) {
        const k = 7.0 / speed;
        ball.vx *= k;
        ball.vy *= k;
        speed *= k;
      }
    }

    // Downhill-stuck gate (Java line 454-461): a ball that's been creeping on
    // a slope (speed < 0.225) for 250 iterations (~1.5s) loses the slope force
    // for this iteration, letting the < 0.075 stop check below fire cleanly.
    if (isDownhill && speed < 0.225) {
      ball.downhillStuckCounter++;
      if (ball.downhillStuckCounter >= 250) {
        isDownhill = false;
      }
    } else {
      ball.downhillStuckCounter = 0;
    }

    // Magnet-stuck gate (Java line 463-470): same idea as downhill but at 150
    // iterations, since magnet drag tends to be weaker than slope acceleration.
    if (isMagnet && speed < 0.225) {
      ball.magnetStuckCounter++;
      if (ball.magnetStuckCounter >= 150) {
        isMagnet = false;
      }
    } else {
      ball.magnetStuckCounter = 0;
    }

    if (
      speed < 0.075 && !isDownhill && !isMagnet &&
      !spinning && !ball.onHole && !ball.onLiquidOrSwamp
    ) {
      ball.vx = 0;
      ball.vy = 0;
      if (centerVal !== 12 && centerVal !== 14 && centerVal !== 13 && centerVal !== 15) {
        stoppedThisIter = true;
      } else {
        ball.onLiquidOrSwamp = true;
      }
    }

    // Stroke-time safety net.
    ball.iterationsThisStroke++;
    if (ball.iterationsThisStroke > MAX_STROKE_ITERATIONS) {
      ball.vx = 0;
      ball.vy = 0;
      stoppedThisIter = true;
    } else if (ball.iterationsThisStroke > MAX_STROKE_ITERATIONS - 200) {
      ball.vx *= 0.95;
      ball.vy *= 0.95;
    }

    if (ball.onHole || ball.onLiquidOrSwamp) {
      ball.liquidTimer += 0.1;
      if ((ball.onHole && ball.liquidTimer > 2.1666666666666665) ||
          (ball.onLiquidOrSwamp && ball.liquidTimer > 6.0)) {
        if (centerVal === 25) {
          ball.inHole = true;
          ball.stopped = true;
          return { stopped: true, inHole: true };
        }
        if (centerVal === 12 || centerVal === 14) {
          // Water — respawn at last shore (waterEvent=1) or back where the
          // player hit from (waterEvent=0, the default).
          if (ctx.waterEvent === 1) {
            ball.x = ball.shoreX;
            ball.y = ball.shoreY;
          } else {
            ball.x = ball.strokeStartX;
            ball.y = ball.strokeStartY;
            ball.shoreX = ball.strokeStartX;
            ball.shoreY = ball.strokeStartY;
          }
          ball.vx = 0;
          ball.vy = 0;
        } else if (centerVal === 13 || centerVal === 15) {
          // Acid — always reset to the track's start position (Java behaviour).
          resetToStart(ball, ctx);
        }
        ball.onHole = false;
        ball.onLiquidOrSwamp = false;
        ball.liquidTimer = 0;
        stoppedThisIter = true;
      }
    }

    if (stoppedThisIter && !ball.onHole) {
      ball.stopped = true;
      return { stopped: true, inHole: false };
    }
  }
  return { stopped: false, inHole: false };
}
