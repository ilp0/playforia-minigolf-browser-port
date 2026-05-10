// Vite middleware that lets the browser dashboard start/stop the
// autoresearch loop. The loop itself is a Node CLI (research_loop.ts);
// this plugin spawns it in the background, tracks the PID in a file,
// and exposes:
//
//   POST /api/loop/start  body: { trainSecs?, mapsCsv?, logPath?,
//                                  agentCmd?, maxIterations? }
//   POST /api/loop/stop
//   GET  /api/loop/status
//   GET  /api/loop/events?since=N  (returns the JSONL events tail)
//
// Why a Vite plugin: Vite already runs a dev server on localhost:5180,
// so we get HTTP "for free" without bringing in express. Production
// builds skip this plugin entirely - the dashboard is a static page,
// the loop is a CLI; mixing them via a server is dev-mode convenience.

import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const PID_PATH = resolve(here, ".loop_pid.json");
const STATUS_PATH = resolve(here, ".loop_status.json");
const EVENTS_PATH = resolve(here, "research_loop_events.jsonl");
const STOP_FLAG_PATH = resolve(here, ".loop_stop");
const LOOP_SCRIPT = resolve(here, "research_loop.ts");

interface PidFile {
  pid: number;
  started_at: string;
}

interface StartBody {
  trainSecs?: number;
  evalEps?: number;
  mapsCsv?: string;
  logPath?: string;
  agentCmd?: string;
  maxIterations?: number;
  budget?: "short" | "default" | "long";
}

function readPid(): PidFile | null {
  if (!existsSync(PID_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PID_PATH, "utf8")) as PidFile;
  } catch {
    return null;
  }
}

/** Best-effort liveness check. Sending signal 0 raises ESRCH if the
 *  process is gone, succeeds otherwise. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStatus(): unknown | null {
  if (!existsSync(STATUS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readEventsTail(maxLines = 100): unknown[] {
  if (!existsSync(EVENTS_PATH)) return [];
  try {
    const text = readFileSync(EVENTS_PATH, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxLines);
    const out: unknown[] = [];
    for (const l of tail) {
      try {
        out.push(JSON.parse(l));
      } catch {
        // ignore
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function startLoop(body: StartBody): { ok: true; pid: number } | { ok: false; error: string } {
  // Reject if already running.
  const existing = readPid();
  if (existing && isAlive(existing.pid)) {
    return { ok: false, error: `loop already running (pid ${existing.pid})` };
  }

  const args = [
    "--experimental-strip-types",
    LOOP_SCRIPT,
    "--max-iterations",
    String(body.maxIterations ?? 1000),
    "--budget",
    body.budget ?? "default",
    "--agent-cmd",
    body.agentCmd ?? "claude --print",
  ];
  if (body.trainSecs != null) args.push("--train-secs", String(body.trainSecs));
  if (body.evalEps != null) args.push("--eval-eps", String(body.evalEps));
  if (body.mapsCsv) args.push("--maps", body.mapsCsv);
  if (body.logPath) args.push("--log-path", body.logPath);

  // detached:false so the child dies if the parent (Vite) does -
  // we don't want zombie loops outliving the dev server. Stdio
  // ignored to decouple lifetimes; the loop logs to its own files.
  const child = spawn(process.execPath, args, {
    cwd: here,
    detached: false,
    stdio: "ignore",
  });
  child.unref(); // don't keep Vite's event loop alive on the child

  if (typeof child.pid !== "number") {
    return { ok: false, error: "spawn returned no pid" };
  }
  // The child writes its own .loop_pid.json on startup, but we also
  // record here in case the child dies before doing so.
  writeFileSync(
    PID_PATH,
    JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }),
  );
  return { ok: true, pid: child.pid };
}

/** Kill the loop process AND all of its descendants (claude --print,
 *  the spawned research_eval.ts, etc). Without this, only the parent
 *  Node process dies and its children leak. Cross-platform: taskkill
 *  on Windows, kill -TERM on the process group on POSIX. */
function killProcessTree(pid: number): { method: string; ok: boolean } {
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return { method: "taskkill /T /F", ok: r.status === 0 };
  }
  // POSIX: kill the process group. The Node child was spawned without
  // setsid so its group is the same as ours; use -pid to send to the
  // whole group. Fallback to a plain kill if that fails.
  try {
    process.kill(-pid, "SIGTERM");
    return { method: "kill -TERM -pgid", ok: true };
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return { method: "kill -TERM pid", ok: true };
    } catch {
      return { method: "kill", ok: false };
    }
  }
}

function stopLoop(): { ok: true; pid: number; method: string } | { ok: false; error: string } {
  const existing = readPid();
  if (!existing) return { ok: false, error: "no loop running" };
  if (!isAlive(existing.pid)) {
    // Stale PID file.
    try { unlinkSync(PID_PATH); } catch { /* ignore */ }
    return { ok: false, error: `pid ${existing.pid} not alive (cleared stale pidfile)` };
  }
  // Two layers:
  //   1. Stop-flag file - the loop polls this between iterations and
  //      exits gracefully if seen. Only useful if the loop is between
  //      iterations OR mid-eval; doesn't interrupt a long spawnSync.
  //   2. Process-tree kill - tears down the loop, its claude --print
  //      child, and any in-flight research_eval.ts. This is what the
  //      user actually expects when they click Stop.
  try {
    writeFileSync(STOP_FLAG_PATH, new Date().toISOString());
  } catch {
    // ignore - tree kill alone is enough
  }
  const k = killProcessTree(existing.pid);
  // Best-effort cleanup of stale state files. The loop's `exit`
  // handler does this too, but it may not run if we just terminated it.
  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
  try { unlinkSync(STATUS_PATH); } catch { /* ignore */ }
  try {
    appendFileSync(
      EVENTS_PATH,
      JSON.stringify({ ts: new Date().toISOString(), event: "stopped_by_user", method: k.method }) + "\n",
    );
  } catch { /* ignore */ }
  return { ok: true, pid: existing.pid, method: k.method };
}

export function autoresearchPlugin(): Plugin {
  return {
    name: "autoresearch-control",
    apply: "serve", // dev only
    configureServer(server) {
      const handle: Connect.NextHandleFunction = async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/loop/")) return next();
        try {
          if (req.url === "/api/loop/start" && req.method === "POST") {
            const body = await readJsonBody<StartBody>(req);
            const result = startLoop(body);
            return send(res, result.ok ? 200 : 409, result);
          }
          if (req.url === "/api/loop/stop" && req.method === "POST") {
            const result = stopLoop();
            return send(res, result.ok ? 200 : 409, result);
          }
          if (req.url.startsWith("/api/loop/status") && req.method === "GET") {
            const pid = readPid();
            const alive = pid ? isAlive(pid.pid) : false;
            const status = readStatus();
            return send(res, 200, {
              running: alive,
              pid: alive && pid ? pid.pid : null,
              started_at: alive && pid ? pid.started_at : null,
              loop_status: status,
            });
          }
          if (req.url.startsWith("/api/loop/events") && req.method === "GET") {
            const url = new URL(req.url, "http://x");
            const max = Number(url.searchParams.get("max") ?? "200");
            const events = readEventsTail(Number.isFinite(max) ? Math.min(1000, max) : 200);
            return send(res, 200, { events });
          }
          return send(res, 404, { error: "unknown endpoint" });
        } catch (e) {
          return send(res, 500, { error: (e as Error).message });
        }
      };
      server.middlewares.use(handle);
    },
  };
}
