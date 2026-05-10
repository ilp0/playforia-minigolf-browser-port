// HIO list page - renders /hio-scan.json with filter, sort, deep-link
// to the single-track viewer.
//
// Data comes from `node --experimental-strip-types scripts/scan-hio.mjs`,
// which writes hio-scan.json with one row per track.

interface ScanRow {
  file: string;
  name: string;
  hio: boolean;
  action?: { dx: number; dy: number };
  candidatesTried?: number;
  secs: number;
  timed_out?: boolean;
  error?: string;
  /** Best stroke count any human has logged for this track. From the
   *  .track I-line. -1 means no human record exists. */
  bestPar?: number;
  bestPlayer?: string | null;
  /** True if the HIO trajectory passed through wall pixels - the
   *  inside-corner-suppression rule in handleWallCollision (faithful
   *  port of a Java quirk) lets some shots phase through walls. Such
   *  HIOs aren't reachable by human aim and we hide them by default. */
  wall_clip?: boolean;
}

interface ScanFile {
  scanned_at: string;
  total: number;
  completed?: number;
  hio_count: number;
  err_count?: number;
  timeout_count?: number;
  budget_secs?: number;
  workers?: number;
  angle_step?: number;
  power_step?: number;
  elapsed_secs: number;
  tracks: ScanRow[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

let cache: ScanFile | null = null;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchScan(): Promise<ScanFile | null> {
  try {
    const r = await fetch("/hio-scan.json?_=" + Date.now());
    if (!r.ok) return null;
    // Vite serves a SPA fallback (index.html) for any path it can't
    // match, so a missing /hio-scan.json comes back as HTML with 200.
    // Reject anything that isn't a JSON content-type or that doesn't
    // start with "{" - either condition means the file isn't there.
    const ct = r.headers.get("content-type") ?? "";
    const text = await r.text();
    if (!ct.includes("json") && !text.trim().startsWith("{")) return null;
    return JSON.parse(text) as ScanFile;
  } catch {
    return null;
  }
}

function renderBanner(scan: ScanFile | null): void {
  const el = $("banner")!;
  if (!scan) {
    el.innerHTML = `<div class="progress-banner">
      No <code>hio-scan.json</code> found. Run the scan first:<br>
      <code style="font-family:ui-monospace,monospace">node --experimental-strip-types scripts/scan-hio.mjs</code>
    </div>`;
    return;
  }
  // The script writes partial progress every 50 tracks; if completed <
  // total, the scan is still running (or was interrupted).
  const inProgress =
    scan.completed != null && scan.completed < scan.total;
  if (inProgress) {
    const pct = ((scan.completed! / scan.total) * 100).toFixed(0);
    const eta = (scan.elapsed_secs / scan.completed!) * (scan.total - scan.completed!);
    el.innerHTML = `<div class="progress-banner scanning">
      Scan in progress: <b>${scan.completed}/${scan.total}</b> (${pct}%) ·
      ${scan.hio_count} HIO so far · elapsed ${scan.elapsed_secs.toFixed(0)}s ·
      ETA ${eta.toFixed(0)}s · <em>page auto-refreshes; check back later for the full list</em>
    </div>`;
  } else {
    el.innerHTML = "";
  }
}

function renderStats(scan: ScanFile): void {
  const el = $("stats")!;
  const total = scan.total;
  const completed = scan.completed ?? scan.tracks.length;
  const hio = scan.hio_count;
  const errors = scan.err_count ?? 0;
  const timeouts = scan.timeout_count ?? 0;
  const nonHio = completed - hio - errors - timeouts;
  const budget = scan.budget_secs ?? 0;
  // Real HIO = HIO found AND no wall-clip. Wall-clips are physics
  // quirks (handleWallCollision's inside-corner suppression lets the
  // ball phase through walls), counted separately so the user knows
  // why the "HIO-able" count is lower than the raw search hits.
  const wallClip = scan.tracks.filter((r) => r.hio && r.wall_clip).length;
  const realHio = hio - wallClip;
  // "Unknown HIO" - real HIO AND no human ever recorded 1. Candidate
  // list of human-playable but undiscovered 1-stroke routes.
  const unknownHio = scan.tracks.filter(
    (r) => r.hio && !r.wall_clip && (r.bestPar ?? -1) > 1,
  ).length;
  el.innerHTML = `
    <div class="stat"><div class="val">${total}</div><div class="lbl">total tracks</div><div class="sub">in port/server/tracks</div></div>
    <div class="stat"><div class="val">${realHio}</div><div class="lbl">HIO-able (real)</div><div class="sub">${((realHio / Math.max(1, completed)) * 100).toFixed(0)}% of scanned · trajectory clears walls</div></div>
    <div class="stat" style="border-color:#d29922;">
      <div class="val" style="color:#d29922">${unknownHio}</div>
      <div class="lbl">unknown HIO</div>
      <div class="sub">real HIO but bestPar &gt; 1</div>
    </div>
    <div class="stat"><div class="val">${wallClip}</div><div class="lbl">wall-clip</div><div class="sub">trajectory phased through walls</div></div>
    <div class="stat"><div class="val">${nonHio}</div><div class="lbl">grid exhausted</div><div class="sub">no HIO at this resolution</div></div>
    <div class="stat"><div class="val">${timeouts}</div><div class="lbl">timed out</div><div class="sub">${budget > 0 ? `budget ${budget}s` : "n/a"}</div></div>
    <div class="stat"><div class="val">${errors}</div><div class="lbl">errors</div></div>
    <div class="stat"><div class="val">${(scan.elapsed_secs / 60).toFixed(1)}m</div><div class="lbl">scan wall</div><div class="sub">${(scan.elapsed_secs / Math.max(1, completed) * 1000).toFixed(0)}ms / track avg</div></div>
  `;
}

function rowHtml(r: ScanRow): string {
  const badge = r.error
    ? `<span class="badge fail">error</span>`
    : r.hio && r.wall_clip
      ? `<span class="badge fail" style="background:rgba(210,153,34,0.15);color:#d29922;" title="The 'HIO' trajectory phased through walls due to the inside-corner-suppression quirk in handleWallCollision. Not actually playable.">wall-clip</span>`
      : r.hio
        ? `<span class="badge">HIO</span>`
        : r.timed_out
          ? `<span class="badge fail" style="background:rgba(210,153,34,0.15);color:#d29922;">timeout</span>`
          : `<span class="badge fail" style="background:rgba(139,148,158,0.15);color:var(--muted);">none</span>`;
  const action = r.action
    ? `(${r.action.dx.toFixed(1)}, ${r.action.dy.toFixed(1)})`
    : "—";
  const tries = r.candidatesTried != null ? r.candidatesTried.toLocaleString() : "—";
  const secs = r.secs.toFixed(2);
  const link = `/index.html?map=${encodeURIComponent(r.file)}`;
  const bp = r.bestPar ?? -1;
  // "Unknown HIO": physics says HIO-able, but no human has logged 1.
  // Highlight the bestPar cell so it stands out.
  const unknownHio = r.hio && bp > 1;
  const bestParCell =
    bp <= 0
      ? `<span style="color:var(--muted-2)">no record</span>`
      : unknownHio
        ? `<span style="color:#d29922;font-weight:600;" title="HIO-able by physics but humans never got 1!">${bp}${r.bestPlayer ? ` (${escapeHtml(r.bestPlayer)})` : ""}</span>`
        : `${bp}${r.bestPlayer ? ` <span style="color:var(--muted-2)">(${escapeHtml(r.bestPlayer)})</span>` : ""}`;
  return `<tr>
    <td>${escapeHtml(r.name)}</td>
    <td><a class="file-link" href="${link}">${escapeHtml(r.file)}</a></td>
    <td>${badge}</td>
    <td>${bestParCell}</td>
    <td style="font-family:ui-monospace,monospace;font-size:12px">${action}</td>
    <td>${tries}</td>
    <td>${secs}</td>
    <td><a class="file-link" href="${link}">open →</a></td>
  </tr>`;
}

function applyFilters(): ScanRow[] {
  if (!cache) return [];
  const filter = $<HTMLInputElement>("filter")?.value.trim().toLowerCase() ?? "";
  const kind = $<HTMLSelectElement>("kind")?.value ?? "hio";
  const sort = $<HTMLSelectElement>("sort")?.value ?? "candidatesTried";
  let rows = cache.tracks.slice();
  // Filter by kind.
  if (kind === "hio") rows = rows.filter((r) => r.hio && !r.wall_clip);
  else if (kind === "hio-unknown")
    rows = rows.filter((r) => r.hio && !r.wall_clip && (r.bestPar ?? -1) > 1);
  else if (kind === "wall-clip")
    rows = rows.filter((r) => r.hio && !!r.wall_clip);
  else if (kind === "non-hio") rows = rows.filter((r) => !r.hio && !r.error);
  else if (kind === "timeout") rows = rows.filter((r) => !!r.timed_out);
  else if (kind === "errors") rows = rows.filter((r) => !!r.error);
  // Filter by name/file substring.
  if (filter) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(filter) || r.file.toLowerCase().includes(filter),
    );
  }
  // Sort.
  rows.sort((a, b) => {
    switch (sort) {
      case "secs":
        return a.secs - b.secs;
      case "name":
        return a.name.localeCompare(b.name);
      case "file":
        return a.file.localeCompare(b.file);
      case "candidatesTried":
      default:
        // Asc by tries; HIO-found first means smallest "candidates tried"
        // first - those are the easiest HIOs to find.
        return (a.candidatesTried ?? Infinity) - (b.candidatesTried ?? Infinity);
    }
  });
  return rows;
}

function render(): void {
  // Always render the banner — when cache is null it shows the "run
  // the scan first" instructions, and when the scan is in-flight it
  // shows progress.
  renderBanner(cache);
  if (!cache) {
    $("stats")!.innerHTML = "";
    $("tbody")!.innerHTML = `<tr><td colspan="7" class="empty">scan hasn't been run yet</td></tr>`;
    $("count")!.textContent = "";
    $("footer")!.textContent = "";
    return;
  }
  renderStats(cache);
  const rows = applyFilters();
  $("tbody")!.innerHTML =
    rows.length === 0
      ? `<tr><td colspan="7" class="empty">no tracks match the filter</td></tr>`
      : rows.map(rowHtml).join("");
  $("count")!.textContent = `${rows.length} track${rows.length === 1 ? "" : "s"}`;
  $("footer")!.textContent = `scanned ${new Date(cache.scanned_at).toLocaleString()} · regenerate via 'node --experimental-strip-types scripts/scan-hio.mjs'`;
}

async function refresh(): Promise<void> {
  cache = await fetchScan();
  render();
}

function bind(): void {
  $("filter")?.addEventListener("input", render);
  $("kind")?.addEventListener("change", render);
  $("sort")?.addEventListener("change", render);
}

async function init(): Promise<void> {
  bind();
  await refresh();
  // Auto-refresh every 5s in two cases:
  //   - the scan hasn't been run yet (cache is null) - poll so the
  //     page picks up the file as soon as the script writes its first
  //     checkpoint.
  //   - the scan is in flight (cache.completed < cache.total) - poll
  //     so each new 50-track checkpoint shows up live.
  // Stops auto-refreshing once the scan is complete.
  setInterval(async () => {
    const inFlight =
      !cache || (cache.completed != null && cache.completed < cache.total);
    if (inFlight) await refresh();
  }, 5000);
}

init();
