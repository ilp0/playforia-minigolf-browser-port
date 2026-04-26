#!/usr/bin/env node
// Per-worktree dev server manager.
//
// Why: every worktree previously hardcoded vite=5173 / ws=4242, so two
// worktrees couldn't run their dev servers at the same time, and an agent
// re-running `npm run dev` mid-session left an orphan child whose port was
// then re-claimed by the next spawn. This wraps both services with a state
// file so `up` is idempotent and ports are unique per worktree.
//
// Usage:
//   node scripts/devctl.mjs up [--web|--server|--no-web|--no-server]
//   node scripts/devctl.mjs down [--web|--server]
//   node scripts/devctl.mjs restart
//   node scripts/devctl.mjs status
//   node scripts/devctl.mjs info     # one-line summary suitable for hooks
//   node scripts/devctl.mjs url      # prints http://localhost:<webPort>
//   node scripts/devctl.mjs logs [--web|--server] [--lines N] [--follow]
//   node scripts/devctl.mjs reap     # clean state for dead PIDs (no killing)
//   node scripts/devctl.mjs init     # write .claude/settings.local.json hooks

import { spawn, execSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    openSync,
    statSync,
    truncateSync,
    unlinkSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Layout: <worktreeRoot>/port/scripts/devctl.mjs
const PORT_ROOT = resolve(__dirname, "..");
const WORKTREE_ROOT = resolve(PORT_ROOT, "..");

// State and logs live under <worktreeRoot>/.claude (gitignored at repo root).
const CLAUDE_DIR = join(WORKTREE_ROOT, ".claude");
const STATE_FILE = join(CLAUDE_DIR, "dev-state.json");
const LOGS_DIR = join(CLAUDE_DIR, "logs");
const SETTINGS_LOCAL = join(CLAUDE_DIR, "settings.local.json");
const UP_LOCK = join(CLAUDE_DIR, "up.lock");

// Truncate per-service logs that have grown past this on the next `up`.
// Devctl writes only spawn output (no per-request logs), so 1 MB is generous.
const LOG_ROTATE_BYTES = 1 << 20;

const BASE_WEB_PORT = 5173;
const BASE_WS_PORT = 4242;
// 1..PORT_RANGE-1 inclusive; 0 reserved for the main worktree.
const PORT_RANGE = 100;

const SERVICES = ["web", "server"];

// ---- worktree identity --------------------------------------------------

function isMainWorktree() {
    // A linked worktree's `.git` is a regular file ("gitdir: ..."); the main
    // worktree's `.git` is a directory.
    const gitPath = join(WORKTREE_ROOT, ".git");
    try {
        return lstatSync(gitPath).isDirectory();
    } catch {
        return false;
    }
}

function worktreeId() {
    return basename(WORKTREE_ROOT);
}

function hashOffset(s) {
    const h = createHash("sha1").update(s).digest();
    return ((h[0] << 8) | h[1]) % (PORT_RANGE - 1) + 1;
}

// ---- state I/O ----------------------------------------------------------

function readState() {
    try {
        return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
        return {};
    }
}

function writeState(s) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

function ensureDirs() {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    mkdirSync(LOGS_DIR, { recursive: true });
}

// ---- process / port helpers --------------------------------------------

function pidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM means the pid exists but we don't own it; still alive.
        return e.code === "EPERM";
    }
}

function killTree(pid) {
    if (!pid) return;
    if (process.platform === "win32") {
        try {
            execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
        } catch {
            // Already dead or not a process tree we own.
        }
    } else {
        // Try to kill the whole group (detached child).
        try { process.kill(-pid, "SIGTERM"); } catch {}
        try { process.kill(pid, "SIGTERM"); } catch {}
    }
}

// Connect-based, not bind-based: a successful TCP connect to 127.0.0.1:port
// means *some* process is listening. We can't easily verify *which* process
// owns it from node, so callers must combine this with a PID-alive check.
function isPortBound(port) {
    return new Promise((res) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" });
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            sock.destroy();
            res(v);
        };
        sock.on("connect", () => done(true));
        sock.on("error", () => done(false));
        sock.setTimeout(500, () => done(false));
    });
}

// ---- port assignment ----------------------------------------------------

async function ensurePorts(state) {
    if (state.ports?.web && state.ports?.ws) return state.ports;

    if (isMainWorktree()) {
        return { web: BASE_WEB_PORT, ws: BASE_WS_PORT };
    }

    let offset = hashOffset(worktreeId());
    for (let tries = 0; tries < PORT_RANGE; tries++) {
        const web = BASE_WEB_PORT + offset;
        const ws = BASE_WS_PORT + offset;
        // First-time port selection avoids any port currently in use; we
        // persist the chosen pair so collisions don't cause renumbering on
        // every up.
        if (!(await isPortBound(web)) && !(await isPortBound(ws))) {
            return { web, ws };
        }
        offset++;
        // Skip 0 — that's the main worktree's slot.
        if (offset >= PORT_RANGE) offset = 1;
    }
    throw new Error("Could not find a free port pair within range");
}

// ---- service spawn ------------------------------------------------------

function findVite() {
    const candidates = [
        join(PORT_ROOT, "node_modules", "vite", "bin", "vite.js"),
        join(PORT_ROOT, "web", "node_modules", "vite", "bin", "vite.js"),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    throw new Error(
        "vite not found in node_modules — run `npm install` in port/ first",
    );
}

function spawnService(svc, ports) {
    const logFile = join(LOGS_DIR, `${svc}.log`);
    const fd = openSync(logFile, "a");
    let cmd, args, cwd;
    const env = {
        ...process.env,
        WS_PORT: String(ports.ws),
        WEB_PORT: String(ports.web),
        WORKTREE_ID: worktreeId(),
    };

    if (svc === "web") {
        cmd = process.execPath;
        args = [
            findVite(),
            "--port", String(ports.web),
            "--strictPort",
        ];
        cwd = join(PORT_ROOT, "web");
    } else if (svc === "server") {
        cmd = process.execPath;
        args = [
            "--experimental-strip-types",
            "--no-warnings",
            "src/main.ts",
            "--port", String(ports.ws),
        ];
        cwd = join(PORT_ROOT, "server");
    } else {
        throw new Error(`unknown service: ${svc}`);
    }

    // Append a marker line so logs/<svc>.log shows when each spawn happened.
    writeFileSync(
        logFile,
        `\n--- ${new Date().toISOString()} ${svc} pid=? port=${
            svc === "web" ? ports.web : ports.ws
        } cwd=${cwd} ---\n`,
        { flag: "a" },
    );

    const child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ["ignore", fd, fd],
        detached: true,
        windowsHide: true,
    });
    child.unref();

    return {
        pid: child.pid,
        port: svc === "web" ? ports.web : ports.ws,
        started: new Date().toISOString(),
    };
}

// ---- subcommands --------------------------------------------------------

async function cmdUp(args) {
    ensureDirs();
    // Advisory lock so two near-simultaneous `up` invocations (parallel
    // agents, hook + manual run) don't both check isPortBound, both see
    // free, and both spawn — the loser dies on Vite's --strictPort and
    // overwrites the winner's state.
    const releaseLock = await acquireUpLock();
    try {
        await runUp(args);
    } finally {
        releaseLock();
    }
}

async function acquireUpLock() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            // wx = exclusive create; fails with EEXIST if another holder exists.
            const fd = openSync(UP_LOCK, "wx");
            writeFileSync(UP_LOCK, String(process.pid));
            return () => {
                try { unlinkSync(UP_LOCK); } catch {}
            };
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
            // If the lock-holder is dead, steal the lock.
            try {
                const holderPid = parseInt(readFileSync(UP_LOCK, "utf8"), 10);
                if (!pidAlive(holderPid)) {
                    try { unlinkSync(UP_LOCK); } catch {}
                    continue;
                }
            } catch {}
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error(`could not acquire ${UP_LOCK} within 5s`);
}

function rotateLog(svc) {
    const f = join(LOGS_DIR, `${svc}.log`);
    try {
        if (statSync(f).size > LOG_ROTATE_BYTES) {
            truncateSync(f, 0);
        }
    } catch {}
}

async function runUp(args) {
    const want = serviceFilter(args);
    const state = readState();
    const ports = await ensurePorts(state);
    state.ports = ports;
    state.id = worktreeId();

    for (const svc of SERVICES) {
        if (!want[svc]) continue;
        const port = svc === "web" ? ports.web : ports.ws;
        const proc = state[svc];

        if (proc && pidAlive(proc.pid)) {
            // Trust the recorded PID. The port may not be bound yet during
            // a slow startup, but the process is ours and will get there.
            console.error(`${svc}: already running pid=${proc.pid} port=${port}`);
            continue;
        } else if (proc) {
            delete state[svc];
        }

        // PID dead (or never set). Don't spawn on a port someone else owns —
        // that's almost certainly another worktree, the main worktree's
        // dev server, or a stale process whose ownership we can't confirm.
        if (await isPortBound(port)) {
            console.error(
                `${svc}: port ${port} bound by an unknown process — refusing to spawn. ` +
                `Investigate or pick a different port. State file: ${STATE_FILE}`,
            );
            process.exitCode = 1;
            continue;
        }
        rotateLog(svc);
        const info = spawnService(svc, ports);
        state[svc] = info;
        // Brief liveness check: detached children that die during startup
        // (missing dep, syntax error, port grab race) would otherwise be
        // reported as "started" but tail an empty log.
        await new Promise((r) => setTimeout(r, 600));
        if (!pidAlive(info.pid)) {
            console.error(
                `${svc}: spawned pid=${info.pid} died during startup. ` +
                `See ${join(LOGS_DIR, svc + ".log")}`,
            );
            delete state[svc];
            process.exitCode = 1;
            continue;
        }
        console.error(`${svc}: started pid=${info.pid} port=${info.port}`);
    }
    writeState(state);
    printStatus(state);
}

async function cmdDown(args) {
    const want = serviceFilter(args);
    const state = readState();
    for (const svc of SERVICES) {
        if (!want[svc]) continue;
        const proc = state[svc];
        if (!proc) {
            console.error(`${svc}: no tracked pid`);
            continue;
        }
        if (pidAlive(proc.pid)) {
            killTree(proc.pid);
            console.error(`${svc}: killed pid=${proc.pid}`);
        } else {
            console.error(`${svc}: already dead pid=${proc.pid}`);
        }
        delete state[svc];
    }
    writeState(state);
}

async function cmdRestart(args) {
    await cmdDown(args);
    // Brief delay so the OS releases the port before we re-bind.
    await new Promise((r) => setTimeout(r, 250));
    await cmdUp(args);
}

async function cmdStatus() {
    const state = readState();
    printStatus(state);
}

function printStatus(state) {
    const ports = state.ports ?? {};
    const id = state.id ?? worktreeId();
    console.log(`worktree: ${id}${isMainWorktree() ? " (main)" : ""}`);
    console.log(`  web:    port=${ports.web ?? "?"}  url=http://localhost:${ports.web ?? "?"}`);
    console.log(`  ws:     port=${ports.ws ?? "?"}`);
    for (const svc of SERVICES) {
        const proc = state[svc];
        if (!proc) {
            console.log(`  ${svc}:     (not started)`);
            continue;
        }
        const alive = pidAlive(proc.pid) ? "alive" : "dead";
        console.log(
            `  ${svc}:     pid=${proc.pid} port=${proc.port} ${alive}  started=${proc.started}`,
        );
    }
}

function cmdInfo() {
    const state = readState();
    const ports = state.ports ?? {};
    const id = state.id ?? worktreeId();
    const webStat = state.web && pidAlive(state.web.pid) ? "up" : "down";
    const srvStat = state.server && pidAlive(state.server.pid) ? "up" : "down";
    const webPort = ports.web ?? "?";
    const wsPort = ports.ws ?? "?";
    console.log(
        `[devctl] worktree=${id} web=${webStat}@${webPort} server=${srvStat}@${wsPort} ` +
        `url=http://localhost:${webPort}`,
    );
}

async function cmdUrl() {
    const state = readState();
    const ports = state.ports ?? (await ensurePorts(state));
    console.log(`http://localhost:${ports.web}`);
}

function cmdLogs(args) {
    const want = serviceFilter(args);
    const lines = parseIntFlag(args, "--lines", 80);
    const follow = args.includes("--follow") || args.includes("-f");
    const targets = SERVICES.filter((s) => want[s]);
    if (follow) {
        // Cheap tail -f via spawn so we don't reimplement file watching.
        for (const svc of targets) {
            const f = join(LOGS_DIR, `${svc}.log`);
            if (!existsSync(f)) continue;
            const child = spawn(
                process.platform === "win32" ? "powershell" : "tail",
                process.platform === "win32"
                    ? ["-Command", `Get-Content -Path '${f}' -Tail ${lines} -Wait`]
                    : ["-n", String(lines), "-f", f],
                { stdio: "inherit" },
            );
            child.on("exit", () => {});
        }
        return;
    }
    for (const svc of targets) {
        const f = join(LOGS_DIR, `${svc}.log`);
        if (!existsSync(f)) {
            console.log(`--- ${svc}: no log ---`);
            continue;
        }
        const text = readFileSync(f, "utf8");
        const out = text.split(/\r?\n/).slice(-lines).join("\n");
        console.log(`--- ${svc} (${f}) ---`);
        console.log(out);
    }
}

function cmdReap() {
    const state = readState();
    let changed = false;
    for (const svc of SERVICES) {
        const proc = state[svc];
        if (proc && !pidAlive(proc.pid)) {
            console.error(`${svc}: reaped dead pid=${proc.pid}`);
            delete state[svc];
            changed = true;
        }
    }
    if (changed) writeState(state);
    cmdInfo();
}

function cmdInit() {
    ensureDirs();
    const settings = existsSync(SETTINGS_LOCAL)
        ? JSON.parse(readFileSync(SETTINGS_LOCAL, "utf8"))
        : {};
    settings.hooks ??= {};
    // Write the absolute script path so hooks fire correctly regardless of
    // which directory `claude` was started from (relative `node port/...`
    // breaks if launched from inside port/ or any other subdir).
    const scriptPath = __filename;
    const node = JSON.stringify(process.execPath);
    const script = JSON.stringify(scriptPath);
    const upsert = (event, args) => {
        const command = `${node} ${script} ${args}`;
        settings.hooks[event] ??= [];
        // Drop any prior entry pointing at this script (stale relative
        // commands, older absolute paths, etc.) before adding the fresh one.
        settings.hooks[event] = settings.hooks[event]
            .map((g) => ({
                ...g,
                hooks: (g.hooks ?? []).filter(
                    (h) => !(h.command ?? "").includes("devctl.mjs"),
                ),
            }))
            .filter((g) => (g.hooks ?? []).length > 0);
        settings.hooks[event].push({
            hooks: [{ type: "command", command }],
        });
    };
    upsert("SessionStart", "reap");
    upsert("SessionEnd", "down");
    writeFileSync(SETTINGS_LOCAL, JSON.stringify(settings, null, 2) + "\n");
    console.error(`wrote ${SETTINGS_LOCAL}`);
}

// ---- arg parsing --------------------------------------------------------

function serviceFilter(args) {
    // Default: both services. `--web`/`--server` narrows to one;
    // `--no-web`/`--no-server` excludes one.
    const onlyWeb = args.includes("--web");
    const onlyServer = args.includes("--server");
    const noWeb = args.includes("--no-web");
    const noServer = args.includes("--no-server");
    if (onlyWeb && !onlyServer) return { web: true, server: false };
    if (onlyServer && !onlyWeb) return { web: false, server: true };
    return { web: !noWeb, server: !noServer };
}

function parseIntFlag(args, flag, def) {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) return def;
    const n = parseInt(args[i + 1], 10);
    return Number.isFinite(n) ? n : def;
}

// ---- main ---------------------------------------------------------------

const [, , subcommand = "status", ...rest] = process.argv;

const dispatch = {
    up: cmdUp,
    start: cmdUp,
    down: cmdDown,
    stop: cmdDown,
    restart: cmdRestart,
    status: cmdStatus,
    info: cmdInfo,
    url: cmdUrl,
    logs: cmdLogs,
    reap: cmdReap,
    init: cmdInit,
    help: () => printHelp(),
    "--help": () => printHelp(),
    "-h": () => printHelp(),
};

function printHelp() {
    console.log(
        readFileSync(__filename, "utf8")
            .split(/\r?\n/)
            .slice(2, 22)
            .map((l) => l.replace(/^\/\/ ?/, ""))
            .join("\n"),
    );
}

const fn = dispatch[subcommand];
if (!fn) {
    console.error(`unknown subcommand: ${subcommand}`);
    printHelp();
    process.exit(2);
}

await fn(rest);
