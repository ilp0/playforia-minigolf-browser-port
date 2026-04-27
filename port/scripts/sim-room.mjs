#!/usr/bin/env node
// sim-room — spin up bot players against a running dev server so a human (or
// browser preview) can verify multiplayer-flow features that need ≥ 2 clients.
//
// Why: many features in port/web/src/panels/ (gamelist transitions, drop-in
// joining, shared practice, full-room badges, …) only manifest when a second
// player exists. Manually opening N browser tabs and clicking through the
// login + lobby + create flow each time is tedious; this tool spawns fake
// WebSocket clients that handshake correctly, sit in the lobby, and run
// scripted scenarios while a browser session observes.
//
// Auto-resolves the dev-server WS port from .claude/dev-state.json (written
// by `npm run dev:up`), so you usually don't need to pass --port. Each bot
// auto-replies to server pings so they stay alive past the idle timeout.
//
// Usage:
//   node scripts/sim-room.mjs [scenario] [flags]
//
// Scenarios:
//   wait          A creates a room and parks (default). Browser session
//                 sees the room in the gamelist, can join.
//   fill          A creates, fillers join until the room is full and the
//                 game starts. Bots park in-game.
//   drop-in       Same as `fill`, then one filler leaves so an in-progress
//                 room with a free slot is visible from the lobby. Lets you
//                 test "(In progress)" badge + Drop-in flow.
//   practice      A creates a multi-player room and presses the Practice
//                 button so a shared practice run is active. Browser can
//                 join (sendPracticeTrackTo catch-up).
//   practice-pair Like `practice`, but a second bot joins the room first —
//                 so the practice run already has two players before the
//                 browser arrives.
//
// Flags:
//   --port <n>       WS port (default: read from .claude/dev-state.json,
//                    falling back to 4242).
//   --size <n>       Room max players (default: 2).
//   --tracks <n>     Configured track count for the room (default: 3).
//   --type <n>       Track-type id 0..6 (0=all, 1=basic, …) (default: 0).
//   --max-strokes <n>  Max strokes per track (default: 10).
//   --name <s>       Room name (default: "SimRoom").
//   --hold <s>       How long bots stay connected after the scenario
//                    reaches its rest state, in seconds (default: 600).
//                    Pass 0 to disconnect immediately.
//   --verbose        Echo every received packet per bot (debug only).
//   --help, -h       Print this banner and exit.
//
// Output: stable status lines like `READY scenario=fill gameId=3` so a parent
// shell or test harness can grep for the moment the desired state is reached.
// On Ctrl-C every bot closes its socket and the process exits 0.

import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT_ROOT = resolve(__dirname, "..");
const WORKTREE_ROOT = resolve(PORT_ROOT, "..");

// ---- arg parsing -----------------------------------------------------------

function usage() {
    // Print only the leading comment block (the file's banner). Stop at the
    // first non-comment line so per-section divider comments deeper in the
    // file don't get swept into the help output.
    const lines = readFileSync(__filename, "utf8").split("\n");
    const out = [];
    for (const l of lines) {
        if (l.startsWith("#!")) continue;
        if (!l.startsWith("//")) break;
        out.push(l.replace(/^\/\/ ?/, ""));
    }
    process.stdout.write(out.join("\n") + "\n");
}

function parseArgs(argv) {
    const args = { scenario: "wait", flags: {} };
    let i = 0;
    if (argv[0] && !argv[0].startsWith("-")) {
        args.scenario = argv[0];
        i = 1;
    }
    while (i < argv.length) {
        const k = argv[i];
        if (k === "--help" || k === "-h") { usage(); process.exit(0); }
        if (k === "--verbose") { args.flags.verbose = true; i++; continue; }
        const v = argv[i + 1];
        switch (k) {
            case "--port": args.flags.port = parseInt(v, 10); break;
            case "--size": args.flags.size = parseInt(v, 10); break;
            case "--tracks": args.flags.tracks = parseInt(v, 10); break;
            case "--type": args.flags.type = parseInt(v, 10); break;
            case "--max-strokes": args.flags.maxStrokes = parseInt(v, 10); break;
            case "--name": args.flags.name = v; break;
            case "--hold": args.flags.hold = parseFloat(v); break;
            default:
                console.error(`unknown flag: ${k}`);
                process.exit(2);
        }
        i += 2;
    }
    return args;
}

function resolvePort(explicit) {
    if (explicit && Number.isFinite(explicit)) return explicit;
    try {
        const stateFile = join(WORKTREE_ROOT, ".claude", "dev-state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        if (state?.ports?.ws) return state.ports.ws;
    } catch {
        // No dev-state.json yet — fall through to default.
    }
    return 4242;
}

// ---- bot client ------------------------------------------------------------

class Bot {
    constructor(name, port, verbose) {
        this.name = name;
        this.port = port;
        this.verbose = verbose;
        this.outSeq = 0;
        this.recv = [];
    }
    async open() {
        this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
        this.ws.on("message", (m) => {
            const s = m.toString();
            this.recv.push(s);
            if (this.verbose) console.log(`[${this.name}] <- ${s}`);
            // Auto-pong so the server doesn't idle-timeout us.
            if (s === "c ping") this.send("c pong");
        });
        this.ws.on("error", (err) => {
            console.error(`[${this.name}] ws error: ${err.message}`);
        });
        await new Promise((res, rej) => {
            this.ws.once("open", () => res());
            this.ws.once("error", (err) => rej(err));
        });
    }
    send(line) {
        if (this.verbose) console.log(`[${this.name}] -> ${line}`);
        this.ws.send(line);
    }
    sendData(...fields) { this.send(`d ${this.outSeq++} ${fields.join("\t")}`); }
    sendCmd(verb, ...args) { this.send(`c ${[verb, ...args].join(" ")}`); }
    waitFor(predicate, label, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                reject(new Error(`[${this.name}] timeout waiting for ${label}`));
            }, timeoutMs);
            const tick = () => {
                const i = this.recv.findIndex(predicate);
                if (i >= 0) {
                    clearTimeout(t);
                    const [s] = this.recv.splice(i, 1);
                    resolve(s);
                    return;
                }
                setTimeout(tick, 20);
            };
            tick();
        });
    }
    close() {
        try { this.ws.close(); } catch { /* */ }
    }
}

async function login(bot) {
    await bot.waitFor((s) => s === "h 1", "h 1");
    await bot.waitFor((s) => s.startsWith("c crt"), "c crt");
    await bot.waitFor((s) => s === "c ctr", "c ctr");
    bot.sendCmd("new");
    await bot.waitFor((s) => s.startsWith("c id "), "c id");
    bot.sendData("version", 35);
    await bot.waitFor((s) => /status\tlogin$/.test(s), "v ack");
    bot.sendData("nick", bot.name);
    bot.sendData("language", "en");
    bot.sendData("logintype", "nr");
    await bot.waitFor((s) => /status\tlogin$/.test(s), "lt ack");
    bot.sendData("login");
    await bot.waitFor((s) => /basicinfo/.test(s), "basicinfo");
    await bot.waitFor((s) => /status\tlobbyselect/.test(s), "lobbyselect");
}

async function intoMultiLobby(bot) {
    bot.sendData("lobbyselect", "select", "x");
    await bot.waitFor((s) => /status\tlobby\tx/.test(s), "lobby x");
    await bot.waitFor((s) => /lobby\townjoin/.test(s), "ownjoin");
    await bot.waitFor((s) => /lobby\tgamelist\tfull/.test(s), "gamelist full");
}

/** Send the room-create packet. The reply doesn't include the gameId for the
 *  creator, so callers usually want to read the lobby's `gamelist add` from a
 *  second bot, OR rely on the fact that on a fresh dev server the next gameId
 *  is monotonically increasing. */
function createRoom(bot, opts) {
    bot.sendData(
        "lobby", "cmpt",
        opts.name,         // room name
        "-",               // password (none)
        0,                 // perms = everyone
        opts.size,         // numPlayers (max)
        opts.tracks,       // numberOfTracks
        opts.type,         // trackType
        opts.maxStrokes,   // maxStrokes
        60,                // strokeTimeout
        0,                 // waterEvent (back to start)
        1,                 // collision on
        0,                 // scoring (per-stroke)
        0,                 // scoringEnd
    );
}

// ---- scenarios -------------------------------------------------------------

const bots = [];

async function scenarioWait(opts) {
    const a = new Bot("SimA", opts.port, opts.verbose);
    bots.push(a);
    await a.open();
    await login(a);
    await intoMultiLobby(a);
    createRoom(a, opts);
    await a.waitFor((s) => /status\tgame/.test(s), "A in game");
    console.log(`READY scenario=wait roomSize=${opts.size}`);
}

async function scenarioFill(opts) {
    const a = new Bot("SimA", opts.port, opts.verbose);
    bots.push(a);
    await a.open(); await login(a); await intoMultiLobby(a);

    const fillers = [];
    for (let i = 1; i < opts.size; i++) {
        const b = new Bot(`SimB${i}`, opts.port, opts.verbose);
        bots.push(b);
        await b.open(); await login(b); await intoMultiLobby(b);
        fillers.push(b);
    }
    createRoom(a, opts);
    // First filler will see a `gamelist add` carrying the gameId.
    let gameId = -1;
    if (fillers[0]) {
        const addLine = await fillers[0].waitFor(
            (s) => /lobby\tgamelist\tadd/.test(s),
            "gamelist add",
        );
        gameId = parseInt(addLine.split("\t")[3] ?? "-1", 10);
    }
    await a.waitFor((s) => /status\tgame/.test(s), "A in game");
    for (const f of fillers) {
        f.sendData("lobby", "jmpt", String(gameId));
        await f.waitFor((s) => /status\tgame/.test(s), `${f.name} in game`);
    }
    await a.waitFor((s) => /game\tstart$/.test(s), "real game start");
    console.log(`READY scenario=fill gameId=${gameId} roomSize=${opts.size}`);
    return { gameId, a, fillers };
}

async function scenarioDropIn(opts) {
    const { fillers, gameId } = await scenarioFill(opts);
    if (fillers.length === 0) {
        console.error("drop-in needs --size >= 2");
        process.exit(2);
    }
    // Last filler bows out — leaves a free seat in an in-progress room.
    await new Promise((r) => setTimeout(r, 600));
    const leaver = fillers[fillers.length - 1];
    leaver.sendData("game", "back");
    await new Promise((r) => setTimeout(r, 200));
    console.log(`READY scenario=drop-in gameId=${gameId} freeSlots=1`);
}

async function scenarioPractice(opts) {
    const a = new Bot("SimA", opts.port, opts.verbose);
    bots.push(a);
    await a.open(); await login(a); await intoMultiLobby(a);
    createRoom(a, opts);
    await a.waitFor((s) => /status\tgame/.test(s), "A in game");
    a.sendData("game", "practice");
    await a.waitFor((s) => /game\tpracticemode\tt$/.test(s), "practicemode t");
    console.log(`READY scenario=practice roomSize=${opts.size}`);
}

async function scenarioPracticePair(opts) {
    const a = new Bot("SimA", opts.port, opts.verbose);
    bots.push(a);
    await a.open(); await login(a); await intoMultiLobby(a);
    const b = new Bot("SimB", opts.port, opts.verbose);
    bots.push(b);
    await b.open(); await login(b); await intoMultiLobby(b);
    createRoom(a, opts);
    const addLine = await b.waitFor(
        (s) => /lobby\tgamelist\tadd/.test(s),
        "gamelist add",
    );
    const gameId = parseInt(addLine.split("\t")[3] ?? "-1", 10);
    await a.waitFor((s) => /status\tgame/.test(s), "A in game");
    b.sendData("lobby", "jmpt", String(gameId));
    await b.waitFor((s) => /status\tgame/.test(s), "B in game");
    a.sendData("game", "practice");
    await a.waitFor((s) => /game\tpracticemode\tt$/.test(s), "A practicemode");
    await b.waitFor((s) => /game\tpracticemode\tt$/.test(s), "B practicemode");
    console.log(`READY scenario=practice-pair gameId=${gameId} roomSize=${opts.size}`);
}

// ---- main ------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const opts = {
        port: resolvePort(args.flags.port),
        size: args.flags.size ?? 2,
        tracks: args.flags.tracks ?? 3,
        type: args.flags.type ?? 0,
        maxStrokes: args.flags.maxStrokes ?? 10,
        name: args.flags.name ?? "SimRoom",
        hold: args.flags.hold ?? 600,
        verbose: !!args.flags.verbose,
    };

    const cleanup = () => {
        for (const b of bots) b.close();
        process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    console.log(`[sim-room] port=${opts.port} scenario=${args.scenario} ` +
        `size=${opts.size} tracks=${opts.tracks} name="${opts.name}"`);

    try {
        switch (args.scenario) {
            case "wait":
            case "create":
                await scenarioWait(opts); break;
            case "fill":
                await scenarioFill(opts); break;
            case "drop-in":
                await scenarioDropIn(opts); break;
            case "practice":
                await scenarioPractice(opts); break;
            case "practice-pair":
                await scenarioPracticePair(opts); break;
            default:
                console.error(`unknown scenario: ${args.scenario}`);
                console.error(`run with --help for the full list.`);
                process.exit(2);
        }
    } catch (err) {
        console.error(`[sim-room] FAIL: ${err instanceof Error ? err.message : err}`);
        cleanup();
    }

    if (opts.hold === 0) {
        cleanup();
    } else {
        // Keep bots alive (auto-ponging) so a browser session has time to
        // observe / interact with whatever state the scenario reached.
        await new Promise((r) => setTimeout(r, opts.hold * 1000));
        cleanup();
    }
}

main();
