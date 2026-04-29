// Drive an end-to-end protocol exchange against an already-running server
// on ws://localhost:4242/ws, mimicking what the browser client will do.
//
// Usage: node --experimental-strip-types --no-warnings src/test-fullflow.ts
import { WebSocket } from "ws";

const URL = process.env.WS_URL ?? "ws://localhost:4242/ws";

const ws = new WebSocket(URL);
const recv: string[] = [];
let outSeq = 0;

function send(line: string): void {
    console.log("→", line);
    ws.send(line);
}
function sendData(...fields: (string | number)[]): void {
    const line = `d ${outSeq++} ${fields.join("\t")}`;
    send(line);
}
function sendCommand(verb: string, ...args: string[]): void {
    send(`c ${[verb, ...args].join(" ")}`);
}

function awaitFrame(predicate: (s: string) => boolean, label: string, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
        const tick = (): void => {
            const idx = recv.findIndex(predicate);
            if (idx >= 0) {
                clearTimeout(t);
                const [s] = recv.splice(idx, 1);
                resolve(s);
                return;
            }
            setTimeout(tick, 25);
        };
        tick();
    });
}

ws.on("message", (raw) => {
    const s = raw.toString();
    console.log("←", s);
    recv.push(s);
});
ws.on("close", () => console.log("[ws] closed"));
ws.on("error", (e) => console.log("[ws] error", e.message));

await new Promise<void>((r) => ws.once("open", () => r()));
console.log("[ws] open");

// Phase 1: server emits h 1, c crt 250, c ctr (in some order)
await awaitFrame((s) => s === "h 1", "h 1");
await awaitFrame((s) => s.startsWith("c crt"), "c crt");
await awaitFrame((s) => s === "c ctr", "c ctr");

// Phase 2: c new -> c id N
sendCommand("new");
const idLine = await awaitFrame((s) => s.startsWith("c id "), "c id");
console.log("got id line:", idLine);

// Phase 3: version -> status login
sendData("version", 35);
await awaitFrame((s) => /^d \d+ status\tlogin$/.test(s), "status login (after version)");

// Phase 4: language + logintype -> status login (again)
sendData("language", "en");
sendData("logintype", "nr");
await awaitFrame((s) => /^d \d+ status\tlogin$/.test(s), "status login (after logintype)");

// Phase 5: login -> basicinfo + status lobbyselect
sendData("login");
await awaitFrame((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
await awaitFrame((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");

// Phase 6: enter single-player lobby
sendData("lobbyselect", "select", 1);
await awaitFrame((s) => /^d \d+ status\tlobby\t1/.test(s), "status lobby 1");
await awaitFrame((s) => /^d \d+ lobby\tusers/.test(s), "lobby users");
await awaitFrame((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");

// Phase 7: start training game (1 track, basic, water on)
sendData("lobby", "cspt", 1, 0, 0);
await awaitFrame((s) => /^d \d+ status\tgame/.test(s), "status game");
await awaitFrame((s) => /^d \d+ game\tgameinfo\t/.test(s), "game gameinfo");
await awaitFrame((s) => /^d \d+ game\tplayers/.test(s), "game players");
await awaitFrame((s) => /^d \d+ game\towninfo\t/.test(s), "game owninfo");
await awaitFrame((s) => /^d \d+ game\tstart$/.test(s), "game start");
await awaitFrame((s) => /^d \d+ game\tresetvoteskip/.test(s), "resetvoteskip");
const startTrackFrame = await awaitFrame((s) => /^d \d+ game\tstarttrack\t/.test(s), "starttrack", 8000);
// Async-mode play: no `startturn` follows starttrack. Clients shoot whenever
// their own ball is at rest. (See server/src/game.ts startGame.)

// Confirm we received a real track payload (must contain 'V 1' and a 'T ' field)
const trackPayload = startTrackFrame.split("\t").slice(2).join("\t");
const hasV = trackPayload.includes("V 1");
const tField = trackPayload.split("\t").find((f) => f.startsWith("T "));
if (!hasV || !tField) {
    throw new Error("starttrack payload missing V 1 or T-line");
}
console.log("[OK] track delivered, T-line length =", tField.length);

// Phase 8: simulate a stroke
// encodeCoords(360, 200, 0): v = 360*1500 + 200*4 + 0 = 540800 -> "bn5k" in base 36
const x = 360, y = 200, mode = 0;
const v = x * 1500 + y * 4 + mode;
const encoded = v.toString(36).padStart(4, "0");
sendData("game", "beginstroke", encoded);

// Server writeAll's the beginstroke to all players (incl. shooter): `game beginstroke <id> <ball> <mouse> <seed>`.
// Sleep a moment then send endstroke (didn't make it in hole)
await new Promise((r) => setTimeout(r, 200));
sendData("game", "endstroke", 0, "f");

// Async mode: server broadcasts `game endstroke <id> <strokes> <status>` (no startturn).
await awaitFrame((s) => /^d \d+ game\tendstroke\t0\t1\tf$/.test(s), "endstroke broadcast", 4000);
console.log("[OK] stroke recorded (1 stroke, still on track)");

// Phase 9: simulate hole-in
sendData("game", "beginstroke", encoded);
await new Promise((r) => setTimeout(r, 200));
sendData("game", "endstroke", 0, "t");
// 1-track training -> after final stroke, server sends game\tend
await awaitFrame((s) => /^d \d+ game\tend/.test(s), "game end", 4000);
console.log("[OK] training game ended after hole-in");

console.log("\nALL PHASES PASSED - full protocol path is live end-to-end");
ws.close();
process.exit(0);
