// Structured analytics logging — one JSON line per event to stdout.
//
// Kubernetes captures container stdout, so this is the cheapest way to ship
// "how many players, what did they do" data off-server without integrating an
// analytics service. Every event is a single line of JSON, with at least
// `t` (ISO timestamp) and `evt` (event name); consumers can `jq -c 'select(.evt=="…")'`.
//
// The existing diagnostic console.log lines (`[server]`, `[connection]`, etc.)
// stay unchanged — they don't start with `{`, so they're trivially separable
// from this stream.
//
// Best-effort: if stdout write throws (EPIPE in tests, broken pipe), swallow
// silently. Game logic must never block or crash on analytics.

export type LogFields = Record<string, unknown>;

export function logEvent(evt: string, fields: LogFields = {}): void {
    const payload = { t: new Date().toISOString(), evt, ...fields };
    try {
        process.stdout.write(JSON.stringify(payload) + "\n");
    } catch {
        /* ignore */
    }
}
