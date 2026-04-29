// Smoke check for issue #27 - confirms `S <settings>` rides along in the
// `game starttrack` payload so the client renderer can apply mine/magnet/
// teleport visibility + illusion-shadow flags. Reuses the test-fullflow
// handshake up to starttrack and asserts on the new field.
//
// Usage: WS_URL=ws://localhost:4274/ws node --experimental-strip-types
//        --no-warnings src/test-s-line.ts
import { WebSocket } from "ws";

const URL = process.env.WS_URL ?? "ws://localhost:4274/ws";

const ws = new WebSocket(URL);
const recv: string[] = [];
let outSeq = 0;

function sendData(...fields: (string | number)[]): void {
    ws.send(`d ${outSeq++} ${fields.join("\t")}`);
}
function sendCommand(verb: string, ...args: string[]): void {
    ws.send(`c ${[verb, ...args].join(" ")}`);
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

ws.on("message", (raw) => recv.push(raw.toString()));
ws.on("error", (e) => {
    console.error("ws error:", e);
    process.exit(2);
});

await new Promise<void>((r) => ws.once("open", () => r()));

// Handshake (mirrors test-fullflow phases 1-7).
await awaitFrame((s) => s === "h 1", "h 1");
await awaitFrame((s) => s.startsWith("c crt"), "c crt");
await awaitFrame((s) => s === "c ctr", "c ctr");
sendCommand("new");
await awaitFrame((s) => s.startsWith("c id "), "c id");
sendData("version", 35);
await awaitFrame((s) => /^d \d+ status\tlogin$/.test(s), "status login (post-version)");
sendData("language", "en");
sendData("logintype", "nr");
await awaitFrame((s) => /^d \d+ status\tlogin$/.test(s), "status login (post-logintype)");
sendData("login");
await awaitFrame((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
await awaitFrame((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
sendData("lobbyselect", "select", 1);
await awaitFrame((s) => /^d \d+ status\tlobby\t1/.test(s), "status lobby 1");
await awaitFrame((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");
sendData("lobby", "cspt", 1, 0, 0);
const startFrame = await awaitFrame((s) => /^d \d+ game\tstarttrack\t/.test(s), "starttrack", 8000);

const fields = startFrame.split("\t");
const sField = fields.find((f) => f.startsWith("S "));
const tField = fields.find((f) => f.startsWith("T "));
const cField = fields.find((f) => f.startsWith("C "));

if (!tField) {
    console.error("FAIL: no T line");
    process.exit(1);
}
if (!sField) {
    console.error("FAIL: no S line in starttrack frame - issue #27 fix incomplete");
    process.exit(1);
}
const sBody = sField.substring(2);
// The body itself is "ffff" for the ~93% of stock tracks without an explicit
// S declaration and "<flags><minPlayers><maxPlayers>" (e.g. "tttt14") for the
// ones that do. We just assert the line IS shipped - `parseTrack` /
// `parseSettingsFlags` are unit-tested against real track files in
// shared/src/track.test.ts so the value side is covered there.
console.log("starttrack:", { hasT: true, hasC: !!cField, hasS: true, sBody, sBodyLen: sBody.length });
console.log(`OK: S line shipped (body=${JSON.stringify(sBody)}, len=${sBody.length})`);
ws.close();
process.exit(0);
