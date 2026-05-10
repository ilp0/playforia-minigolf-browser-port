// AI-client renderer.
//
// Delegates the map+ball+aim-line layer to the production TrackRenderer so
// the AI viewer is pixel-identical to the real game. On top we paint the
// AI-only overlays:
//   - per-stroke trail (per episode)
//   - cyan policy-intent arrow (foreground episode only, to keep visuals
//     readable when running multi-env)
//
// Multi-env: with N parallel rollouts we pass N Episode instances. Each
// gets a different ball-colour slot (0..3 cycling) and its own trail
// colour palette. The same network drives all of them - they're just
// independent samples, not independent agents.

import {
  TrackRenderer,
  type BallSprite,
  type AimLine,
} from "../../web/src/game/render.ts";
import type { LoadedTrack } from "./loader.ts";
import type { Episode } from "./env.ts";

export interface AIRenderer {
  render(target: HTMLCanvasElement, episodes: Episode[], opts?: RenderOpts): void;
}

export interface RenderOpts {
  /** Optional intent vector keyed by episode index. Drawn as a cyan arrow
   *  from the matching ball; usually only set for episode 0 to keep
   *  multi-env visuals from getting busy. */
  intents?: Array<{ dx: number; dy: number } | null>;
  /** Optional pathfinder route to render as an overlay - one polyline of
   *  pixel positions from ball to hole. Null skips the overlay. */
  route?: Array<{ x: number; y: number }> | null;
  /** Optional offscreen canvas drawn underneath everything (between the
   *  map and the trails). Used during HIO search to show the fan of
   *  attempted shots accumulating live. */
  underlay?: HTMLCanvasElement | null;
}

export function createRenderer(track: LoadedTrack): AIRenderer {
  const trackRenderer = new TrackRenderer(
    track.map,
    track.atlases,
    track.settingsFlags,
  );

  return {
    render(target: HTMLCanvasElement, episodes: Episode[], opts: RenderOpts = {}) {
      const ctx = target.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;

      // Build the BallSprite array for the production renderer. Cycles
      // through playerIdx 0..3 so 4 episodes show up as the original
      // 4 ball colours (white/red/blue/yellow). Holed balls get hidden.
      const balls: BallSprite[] = [];
      const aimLines: AimLine[] = [];
      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        const state = ep.state();
        balls.push({
          x: state.ballX,
          y: state.ballY,
          playerIdx: i % 4,
          moving: state.status === "in_motion",
          hidden: state.status === "holed",
        });
        const lastShot = ep.shots[ep.shots.length - 1];
        if (
          lastShot &&
          (state.status === "in_motion" || state.status === "awaiting_shot")
        ) {
          aimLines.push({
            fromX: lastShot.fromX,
            fromY: lastShot.fromY,
            toX: lastShot.fromX + lastShot.dx,
            toY: lastShot.fromY + lastShot.dy,
          });
        }
      }
      // The production renderer takes only ONE local-aim line (`aim`); the
      // rest reuse the peer-aim slots so all N show through. We pass the
      // first as `aim` and the rest as `peerAims`.
      const localAim = aimLines[0] ?? null;
      const peerAims = aimLines.slice(1).map((al, idx) => ({
        fromX: al.fromX,
        fromY: al.fromY,
        toX: al.toX,
        toY: al.toY,
        playerIdx: (idx + 1) % 4,
      }));

      trackRenderer.drawFrame(ctx, balls, localAim, peerAims);

      // HIO-search underlay: drawn directly on top of the rendered map
      // (and under trails / route / intent / balls). Built up incrementally
      // by the search itself; we just composite it once per frame.
      if (opts.underlay) {
        ctx.drawImage(opts.underlay, 0, 0);
      }

      // Pathfinder route overlay - drawn under trails so the trails
      // stay readable on top.
      if (opts.route && opts.route.length >= 2) {
        drawRoute(ctx, opts.route);
      }

      // Trails per episode - colour-keyed by episode index so users can
      // distinguish which trail belongs to which ball.
      for (let i = 0; i < episodes.length; i++) {
        drawTrail(ctx, episodes[i], i);
      }

      // Intent arrow only for episode 0 (the one the user is "watching").
      const intent = opts.intents?.[0];
      if (intent) {
        const ep0 = episodes[0];
        if (ep0) {
          const s = ep0.state();
          drawIntentArrow(ctx, s.ballX, s.ballY, intent);
        }
      }
    },
  };
}

function drawIntentArrow(
  ctx: CanvasRenderingContext2D,
  ballX: number,
  ballY: number,
  intent: { dx: number; dy: number },
): void {
  const mag = Math.hypot(intent.dx, intent.dy);
  if (mag < 1) return;

  const tipX = ballX + intent.dx;
  const tipY = ballY + intent.dy;
  ctx.save();
  ctx.strokeStyle = "rgba(120, 230, 255, 0.85)";
  ctx.fillStyle = "rgba(120, 230, 255, 0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ballX, ballY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  const ang = Math.atan2(intent.dy, intent.dx);
  const HEAD = 6;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - HEAD * Math.cos(ang - Math.PI / 6), tipY - HEAD * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(tipX - HEAD * Math.cos(ang + Math.PI / 6), tipY - HEAD * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Pathfinder route overlay: a magenta dashed polyline with small dot
 *  markers at each tile-step waypoint. Distinguishable from the trail
 *  (which is solid) and the intent arrow (which is cyan). */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  route: Array<{ x: number; y: number }>,
): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 80, 220, 0.8)";
  ctx.fillStyle = "rgba(255, 80, 220, 0.8)";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(route[0].x, route[0].y);
  for (let i = 1; i < route.length; i++) {
    ctx.lineTo(route[i].x, route[i].y);
  }
  ctx.stroke();
  // Waypoint markers at each tile-step (skip the ball pixel and hole
  // pixel - those already have their own markers).
  ctx.setLineDash([]);
  for (let i = 1; i < route.length - 1; i++) {
    ctx.beginPath();
    ctx.arc(route[i].x, route[i].y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  episode: Episode,
  episodeIdx: number,
): void {
  const trail = episode.trail;
  if (trail.length < 2) return;

  ctx.save();
  ctx.lineWidth = 1.0;
  let currentStroke = trail[0].stroke;
  ctx.beginPath();
  ctx.moveTo(trail[0].x, trail[0].y);
  for (let i = 1; i < trail.length; i++) {
    const p = trail[i];
    if (p.stroke !== currentStroke) {
      ctx.strokeStyle = strokeColour(currentStroke, episodeIdx);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      currentStroke = p.stroke;
    } else {
      ctx.lineTo(p.x, p.y);
    }
  }
  ctx.strokeStyle = strokeColour(currentStroke, episodeIdx);
  ctx.stroke();
  ctx.restore();
}

/**
 * Trail colour. Hue is anchored to the EPISODE INDEX (so each parallel
 * episode reads as its own colour family) with a per-stroke offset so
 * subsequent strokes within an episode are still distinguishable.
 */
function strokeColour(stroke: number, episodeIdx: number): string {
  // Episode-colour bases roughly matching the in-game ball palette so the
  // ball and its trail look related.
  const baseHue = [200, 0, 220, 50][episodeIdx % 4];
  const h = (baseHue + (stroke % 8) * 12) % 360;
  return `hsla(${h}, 90%, 65%, 0.55)`;
}
