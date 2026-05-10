// Track catalog. We use Vite's `import.meta.glob` to enumerate every .track
// file in the upstream resources tree without manually importing each one,
// then expose a curated subset in the dropdown.
//
// Loaders are lazy (eager: false) so we only fetch the .track text when the
// user actually picks the map - the alternative would bake all 2 000+ tracks
// into the bundle.

const allTracks = import.meta.glob<string>(
  "../../../server/src/main/resources/tracks/tracks/*.track",
  { query: "?raw", import: "default" },
);

/** Curated picker list. Order = how they appear in the dropdown. */
export const PICKER: ReadonlyArray<{ key: string; label: string; file: string }> = [
  { key: "curve1", label: "Curve I (default)", file: "CurveI.track" },
  { key: "curve2", label: "Curve II", file: "CurveII.track" },
  { key: "oval1",  label: "Oval I", file: "OvalI.track" },
  { key: "oval3",  label: "Oval III", file: "OvalIII.track" },
  { key: "barb2",  label: "Barb II", file: "BarbII.track" },
  { key: "100deg", label: "-100 degrees", file: "100degrees.track" },
];

const PATH_PREFIX = "../../../server/src/main/resources/tracks/tracks/";

/**
 * Load one track's raw text by filename. Returns the file content as a
 * string ready to feed into `parseTrack`. Throws if the filename isn't
 * known to the bundler (typo or removed file).
 */
export async function loadTrackByFile(filename: string): Promise<string> {
  const path = PATH_PREFIX + filename;
  const loader = allTracks[path];
  if (!loader) {
    throw new Error(`Unknown track: ${filename}`);
  }
  return await loader();
}

/** Default map at startup. Matches PICKER[0]. */
export const DEFAULT_TRACK_FILE = PICKER[0].file;

/**
 * All track filenames available in the upstream resources tree, sorted
 * case-insensitively for use in a dropdown. ~2000+ entries.
 *
 * The label is just the filename minus `.track` because extracting the
 * friendly `N` line would require fetching every file (each track is its
 * own .track resource). The single-map view shows the friendly name in
 * the header once a map is loaded, so the user gets it then.
 *
 * Curated PICKER labels override the filename-based ones in the dropdown
 * so the well-known maps still show their clean names.
 */
export interface TrackEntry {
  file: string;
  label: string;
  curated: boolean;
}

let cachedAllTracks: TrackEntry[] | null = null;

export function listAllTracks(): TrackEntry[] {
  if (cachedAllTracks) return cachedAllTracks;
  const pickerByFile = new Map<string, string>();
  for (const p of PICKER) pickerByFile.set(p.file, p.label);
  const out: TrackEntry[] = [];
  for (const path of Object.keys(allTracks)) {
    const file = path.substring(PATH_PREFIX.length);
    const curatedLabel = pickerByFile.get(file);
    out.push({
      file,
      label: curatedLabel ?? file.replace(/\.track$/i, ""),
      curated: !!curatedLabel,
    });
  }
  out.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  cachedAllTracks = out;
  return out;
}
