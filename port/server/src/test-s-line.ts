// Smoke check for issue #27 - confirms the `game starttrack` payload carries
// either no S field (track had no S line; client defaults to all visible) or
// an S field with a parseable body. Reuses the test-fullflow handshake up to
// starttrack and asserts shape, not presence (since most stock tracks omit S).
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
// S line is optional now: the server only ships it when the track file
// actually declares one. ~92% of stock tracks have no S line, in which case
// the client falls back to all-visible flags. When the field IS present, the
// body is "<flags>" or "<flags><minPlayers><maxPlayers>" (e.g. "tttt14") -
// `parseTrack` / `parseSettingsFlags` cover the value side in unit tests.
if (sField) {
    const sBody = sField.substring(2);
    if (sBody.length < 4) {
        console.error(`FAIL: S body too short to carry 4 flags: ${JSON.stringify(sBody)}`);
        process.exit(1);
    }
    console.log("starttrack:", { hasT: true, hasC: !!cField, hasS: true, sBody, sBodyLen: sBody.length });
    console.log(`OK: S line shipped (body=${JSON.stringify(sBody)}, len=${sBody.length})`);
} else {
    console.log("starttrack:", { hasT: true, hasC: !!cField, hasS: false });
    console.log("OK: no S line (track had none; client defaults to all visible)");
}
ws.close();
process.exit(0);
