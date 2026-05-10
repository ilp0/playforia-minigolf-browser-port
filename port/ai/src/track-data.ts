// We import the .track file directly as a string via Vite's ?raw query.
// Beats inlining (which is fragile through copy-paste) and avoids needing
// to put track files in publicDir, which is shared with the web client.
//
// Tracks live under server/src/main/resources/tracks/tracks/ in the upstream
// repo (one level above port/). Vite resolves the relative path at build time.

import curveI from "../../../server/src/main/resources/tracks/tracks/CurveI.track?raw";

export const CURVE_I_TRACK = curveI;
