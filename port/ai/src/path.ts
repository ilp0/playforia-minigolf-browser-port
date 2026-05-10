// Tile-coarse pathfinder used as a "where to aim" prior for the agent.
//
// We BFS outward from the hole tile, treating walls / water / acid /
// mines as blocked. The result is a per-tile distance-in-tile-steps
// to the hole. Unreachable tiles get `UNREACHABLE_DIST` so the encoded
// feature reads as "stay away" instead of crashing the math.
//
// Caveats — be honest about what this prior is and isn't:
//   - Tile-centre navigability test. A 1-tile-wide bridge with water on
//     both sides reads as walkable; partial-coverage edge cases will
//     read as fully walkable. Good enough for a hint, not a guarantee.
//   - Pathfinder treats water as impassable. The ball physically CAN
//     roll across water on its way to grass; that's the safety-filter's
//     job to allow. The pathfinder just answers "where should the ball
//     end up", not "what trajectory gets it there".
//   - We pathfind to the track's authoritative `holeX/Y` (which the
//     trainer already trusts), NOT the first `cid === 25` tile we find.
//     Some maps have multiple hole-coloured markers; only one is the
//     real goal.

import {
  TILE_WIDTH,
  TILE_HEIGHT,
  PIXEL_PER_TILE,
  MAP_PIXEL_WIDTH,
  MAP_PIXEL_HEIGHT,
} from "@minigolf/shared";
import type { ParsedMap } from "../../web/src/game/map.ts";

/** Ball radius in pixels, per Java `ball radius 6.5 px`. We round up to
 *  7 so the Minkowski-erosion check has a 1-pixel safety margin against
 *  pixel-quantisation. The pathfinder treats a tile as "ball can stand
 *  here" only if no wall pixel exists within this distance from the
 *  tile centre. */
const BALL_RADIUS_PX = 7;

/** Sentinel for tiles the BFS couldn't reach. Picked to be larger than
 *  any plausible map distance (49+25=74 max with no walls) so the
 *  normalisation in {@link normalizedDistAt} clamps cleanly to 1.0. */
export const UNREACHABLE_DIST = 9999;

/** Whether a single collision PIXEL is a wall (for ball-clip checks).
 *  Mirrors physics' `isWall` (port/web/src/game/physics.ts) plus the
 *  wall pixel colours 1..3 that mark the centre of a wall-shaped tile. */
function isWallPixel(cid: number): boolean {
  if (cid >= 1 && cid <= 3) return true;
  if (cid >= 16 && cid <= 23 && cid !== 19) return true;
  if (cid === 27) return true;
  if (cid === 28 || cid === 30) return true;
  if (cid >= 40 && cid <= 43) return true;
  if (cid === 46) return true;
  return false;
}

/** Whether a tile is impassable (the BALL can't stand at its centre).
 *  Two reasons a tile fails this:
 *    1. The centre pixel is a drowning hazard (water/acid 12..15).
 *    2. ANY wall pixel (per {@link isWallPixel}) sits within
 *       BALL_RADIUS_PX of the tile centre - i.e. the ball would clip
 *       a wall if it tried to stop here.
 *
 *  Effect (2) is "Minkowski erosion" of the walls by ball radius: it
 *  catches the case where a corridor is narrower than the ball even
 *  though its centre pixel is grass. Without this check, the BFS
 *  happily routes through pinch points the ball physically can't fit. */
function tileImpassable(map: ParsedMap, tx: number, ty: number): boolean {
  const cx = tx * PIXEL_PER_TILE + 7;
  const cy = ty * PIXEL_PER_TILE + 7;
  if (cx < 0 || cx >= MAP_PIXEL_WIDTH || cy < 0 || cy >= MAP_PIXEL_HEIGHT) return true;
  const centreCid = map.collision[cy * MAP_PIXEL_WIDTH + cx];
  if (centreCid >= 12 && centreCid <= 15) return true; // drowning hazard
  if (isWallPixel(centreCid)) return true; // centre IS a wall pixel
  // Ball-fit check: any wall pixel within ball radius of the centre?
  // Circular sweep (skip square corners for accuracy).
  const R = BALL_RADIUS_PX;
  const R2 = R * R;
  for (let dy = -R; dy <= R; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= MAP_PIXEL_HEIGHT) return true; // ball would clip off-map
    const dy2 = dy * dy;
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy2 > R2) continue;
      const px = cx + dx;
      if (px < 0 || px >= MAP_PIXEL_WIDTH) return true;
      if (isWallPixel(map.collision[py * MAP_PIXEL_WIDTH + px])) return true;
    }
  }
  return false;
}

/** Read the collision-id at the centre of a given tile. Same 7-pixel
 *  offset the agent's grid encoder uses, so the two views agree on
 *  what "this tile is" means. */
function tileCidAt(map: ParsedMap, tx: number, ty: number): number {
  const px = tx * PIXEL_PER_TILE + 7;
  const py = ty * PIXEL_PER_TILE + 7;
  return map.collision[py * MAP_PIXEL_WIDTH + px];
}

/**
 * Per-tile parent pointer recorded during the BFS: the tile FROM WHICH
 * we discovered this tile. -1 = no parent (a BFS source / hole tile, or
 * unreachable). The route-walker reconstructs the path by following
 * these backwards from the ball to a hole - which automatically handles
 * tricky cases like teleport jumps (parent of a START is the EXIT it
 * was discovered from).
 */
export type ParentMap = Int32Array;

export interface DistanceResult {
  dist: Int16Array;
  parent: ParentMap;
}

/**
 * Tile-step distances from any hole tile to every other tile in the map,
 * plus a parent map for reconstructing routes.
 *
 * Multi-source BFS:
 *   - Every tile whose centre reads `cid === 25` (TILE.HOLE) is seeded
 *     with distance 0. Holing into ANY of them ends the episode, so we
 *     pathfind to the nearest one.
 *   - Teleporters: when the BFS visits a teleport-EXIT tile, it
 *     propagates the same distance to every teleport-START tile of the
 *     same colour, AND records the EXIT as the START's parent. So
 *     walking parent pointers from a START tile correctly traverses
 *     the teleporter to the EXIT, then continues from there.
 *
 *     We can't detect teleport tiles by tile-centre cid sampling -
 *     the rasterizer writes the *background* colour into exit tiles
 *     (33/35/37/39 → bg) so the centre reads as grass. We use the
 *     parsed `map.teleportStarts/teleportExits` arrays as the
 *     authoritative source instead.
 *
 * The `_holeX/_holeY` arguments are kept in the signature for
 * compatibility with older callers but no longer used.
 *
 * Run on track load and cached on `LoadedTrack`; subsequent state
 * encodes are O(1) lookups into the array.
 */
export function buildDistanceMap(
  map: ParsedMap,
  _holeX: number,
  _holeY: number,
): DistanceResult {
  const W = TILE_WIDTH;
  const H = TILE_HEIGHT;
  const dist = new Int16Array(W * H);
  for (let i = 0; i < dist.length; i++) dist[i] = UNREACHABLE_DIST;
  const parent = new Int32Array(W * H);
  parent.fill(-1);

  // Pre-scan: collect every tile's cid (cached so we don't sample twice),
  // a passable bitmap (using the ball-fit check), and seed the queue
  // from hole tiles.
  const cidGrid = new Uint8Array(W * H);
  const passable = new Uint8Array(W * H);
  const queue: number[] = [];
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const cid = tileCidAt(map, tx, ty);
      const idx = ty * W + tx;
      cidGrid[idx] = cid;
      passable[idx] = tileImpassable(map, tx, ty) ? 0 : 1;
      // Hole tiles seed the BFS regardless of the ball-fit check; the
      // hole sprite has the ball drop into it on contact, no "stopping
      // at the centre" requirement applies.
      if (cid === 25) {
        dist[idx] = 0;
        queue.push(idx);
      }
    }
  }
  if (queue.length === 0) return { dist, parent };

  // Build an idx → colour table for teleport tiles, using the parsed
  // arrays. -1 = not a teleport tile. Each colour 0..3 = one of
  // blue/red/yellow/green.
  const exitColourOf = new Int8Array(W * H);
  for (let i = 0; i < exitColourOf.length; i++) exitColourOf[i] = -1;
  const startTilesByColour: number[][] = [[], [], [], []];
  for (let c = 0; c < 4; c++) {
    for (const [px, py] of map.teleportStarts[c]) {
      const tx = Math.floor(px / PIXEL_PER_TILE);
      const ty = Math.floor(py / PIXEL_PER_TILE);
      if (tx >= 0 && tx < W && ty >= 0 && ty < H) {
        startTilesByColour[c].push(ty * W + tx);
      }
    }
    for (const [px, py] of map.teleportExits[c]) {
      const tx = Math.floor(px / PIXEL_PER_TILE);
      const ty = Math.floor(py / PIXEL_PER_TILE);
      if (tx >= 0 && tx < W && ty >= 0 && ty < H) {
        exitColourOf[ty * W + tx] = c;
      }
    }
  }

  // BFS queue as a flat circular buffer of tile indices. ~1200 tiles
  // worst case so a plain array is fine; no need for a typed-array ring.
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const here = dist[idx];

    // Teleport propagation: if this tile is a teleport-EXIT, every
    // teleport-START of the same colour is at the same distance (the
    // warp itself is "free"). We record the EXIT as the START's parent
    // so route-walking from the START lands on the EXIT - which is
    // exactly what physics will do at runtime.
    const exitColour = exitColourOf[idx];
    if (exitColour >= 0) {
      const starts = startTilesByColour[exitColour];
      for (let k = 0; k < starts.length; k++) {
        const sidx = starts[k];
        if (dist[sidx] > here) {
          dist[sidx] = here;
          parent[sidx] = idx;
          queue.push(sidx);
        }
      }
    }

    // 4-connected neighbours. 8-connected would let the path cut
    // diagonally through wall corners, which is unrealistic for
    // tile-coarse navigation.
    const neighbours = [
      [tx + 1, ty],
      [tx - 1, ty],
      [tx, ty + 1],
      [tx, ty - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nidx = ny * W + nx;
      if (dist[nidx] !== UNREACHABLE_DIST) continue;
      if (!passable[nidx]) continue;
      dist[nidx] = (here + 1) as number;
      parent[nidx] = idx;
      queue.push(nidx);
    }
  }
  return { dist, parent };
}

/** Look up the distance map at a pixel position. Out-of-map → unreachable. */
export function tileDistAt(distMap: Int16Array, x: number, y: number): number {
  const tx = (x | 0) / PIXEL_PER_TILE | 0;
  const ty = (y | 0) / PIXEL_PER_TILE | 0;
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) {
    return UNREACHABLE_DIST;
  }
  return distMap[ty * TILE_WIDTH + tx];
}

/** Distance normalised to roughly [0, 1]. Used for the network input
 *  channel; cheap to compute on every encode. Tiles further than the
 *  maximum plausible map traversal saturate at 1. */
const NORMALISE_BY = 60; // a bit more than max-no-walls 49+25 = 74... eh, 60 is plenty
export function normalizedDistAt(distMap: Int16Array, x: number, y: number): number {
  const d = tileDistAt(distMap, x, y);
  if (d >= UNREACHABLE_DIST) return 1.0;
  if (d >= NORMALISE_BY) return 1.0;
  return d / NORMALISE_BY;
}

/**
 * Build the route from (`ballX`, `ballY`) to the nearest hole by walking
 * the parent pointers recorded during BFS. First point is the actual
 * ball pixel; subsequent points are tile centres along the BFS
 * discovery order; last point is the actual final hole tile centre.
 *
 * Walking parents is robust to two cases that tripped up the
 * "find-the-smallest-neighbour-dist" walker:
 *   - Teleport hops, where the START and EXIT have equal distance and
 *     no 4-neighbour scan can pick the right next step.
 *   - Multi-hole maps where `track.holeX/holeY` is the centroid of all
 *     hole pixels and might land on a wall - the walker now ends at
 *     the actual reached hole tile, not the centroid.
 *
 * Returned route is empty if the ball tile is unreachable. A cycle
 * sentinel (visited-set check) protects against malformed parent maps.
 */
export function extractRoute(
  distance: DistanceResult,
  ballX: number,
  ballY: number,
): Array<{ x: number; y: number }> {
  const { dist, parent } = distance;
  const W = TILE_WIDTH;
  const route: Array<{ x: number; y: number }> = [];
  let curIdx = ((ballY | 0) / PIXEL_PER_TILE | 0) * W + ((ballX | 0) / PIXEL_PER_TILE | 0);
  if (curIdx < 0 || curIdx >= W * TILE_HEIGHT) return route;
  if (dist[curIdx] >= UNREACHABLE_DIST) return route;

  route.push({ x: ballX, y: ballY });
  // Cycle sentinel: 49×25 = 1225 tiles, so the longest possible chain
  // is shorter than that. Anything longer is a bug; bail.
  const cap = W * TILE_HEIGHT;
  const visited = new Uint8Array(cap);
  for (let step = 0; step < cap; step++) {
    if (visited[curIdx]) break;
    visited[curIdx] = 1;
    if (dist[curIdx] === 0) break; // we're at a hole tile
    const p = parent[curIdx];
    if (p < 0) break; // no parent; stop
    const ptx = p % W;
    const pty = (p - ptx) / W;
    route.push({
      x: ptx * PIXEL_PER_TILE + PIXEL_PER_TILE / 2,
      y: pty * PIXEL_PER_TILE + PIXEL_PER_TILE / 2,
    });
    curIdx = p;
  }
  return route;
}
