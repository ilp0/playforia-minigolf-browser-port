// Ball physics — port of GameCanvas.run()'s inner loop. Ports more of the
// original mechanics:
//   - Slopes (4..11): per-substep directional acceleration
//   - Water/acid (12..15): when the ball stops on liquid, count up a 6-second
//     timer and respawn at start (water/swamp) or reset (acid/swamp).
//   - One-way walls (20..23): directional pass-through per tile id.
//   - Teleports (32..38 even): on touch, randomly pick an exit.
//   - Mines (28, 30): on contact, eject ball with random velocity.
//   - Magnets (44 attract, 45 repel): apply field force from precomputed map.

import { calculateFriction, type Seed } from "@minigolf/shared";
import { colAt, MAGNET_W, type ParsedMap } from "./map.ts";

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

/** Hard cap on a single stroke. 1500 iterations / 166 Hz ≈ 9 seconds. */
const MAX_STROKE_ITERATIONS = 1500;

/** Apply stroke impulse with deterministic noise — matches GameCanvas.doStroke. */
export function applyStrokeImpulse(
  ball: BallState,
  ctx: PhysicsContext,
  mouseX: number,
  mouseY: number,
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
  // Capture the position the ball had when this stroke began. Java's
  // tempCoordX/Y; water-event=0 returns here on water death.
  ball.strokeStartX = ball.x;
  ball.strokeStartY = ball.y;
  ball.shoreX = ball.x;
  ball.shoreY = ball.y;
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
 * Wall collision — port of GameCanvas.handleWallCollision (lines 1205-1451).
 * Includes one-way wall (20-23) directional pass-through.
 */
function handleWallCollision(ball: BallState, n: Neighbors): void {
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
      const e = getRestitution(n.tr, ball);
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
      const e = getRestitution(n.br, ball);
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
      const e = getRestitution(n.bl, ball);
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
      const e = getRestitution(n.tl, ball);
      temp = ball.vx;
      ball.vx = -ball.vy * e;
      ball.vy = -temp * e;
    }
    return;
  }

  if (top && ball.vy < 0) {
    const e = getRestitution(n.t, ball);
    ball.vx *= e;
    ball.vy *= -e;
  } else if (bottom && ball.vy > 0) {
    const e = getRestitution(n.b, ball);
    ball.vx *= e;
    ball.vy *= -e;
  }
  if (right && ball.vx > 0) {
    const e = getRestitution(n.r, ball);
    ball.vx *= -e;
    ball.vy *= e;
    return;
  }
  if (left && ball.vx < 0) {
    const e = getRestitution(n.l, ball);
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

/** Mine detonation (28 / 30): give ball random velocity in [5.2, 6.5] magnitude. */
function handleMine(ball: BallState, ctx: PhysicsContext): void {
  let speed: number;
  let attempts = 0;
  do {
    ball.vx = (-65 + (ctx.seed.next() % 131)) / 10;
    ball.vy = (-65 + (ctx.seed.next() % 131)) / 10;
    speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    attempts++;
    if (attempts > 50) break;
  } while (speed < 5.2 || speed > 6.5);
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
        handleMine(ball, ctx);
      }

      handleWallCollision(ball, n);
    }

    const ix = (ball.x + 0.5) | 0;
    const iy = (ball.y + 0.5) | 0;
    const n = readNeighbors(map, ix, iy);

    const isDownhill = handleDownhill(ball, centerVal);
    const isMagnet = !onLiquid && !ball.onHole && !ball.onLiquidOrSwamp
      ? handleMagnet(ball, ctx, ix, iy)
      : false;

    let spinning = false;
    if (!ball.onHole) {
      spinning = handleHolePull(ball, n, map, ix, iy);
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
