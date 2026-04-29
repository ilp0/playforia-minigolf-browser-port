// One-off verification: spin up a single-player game, force-decode the
// starttrack frame for each random track until one with magnet shapes
// (raw 20/21) appears. Print whether the S line was shipped and what the
// renderer will do with it. Used after the "absent S = all visible" fix to
// confirm magnet tracks no longer have their magnets clobbered to plain bg.
//
// Usage: WS_URL=ws://localhost:4330/ws node --experimental-strip-types
//        --no-warnings src/verify-magnets.ts
import { WebSocket } from "ws";
import { decodeMap, unpackTile, parseSettingsFlags, ALL_VISIBLE_FLAGS, applySettingsToTileCode } from "@minigolf/shared";

const URL = process.env.WS_URL ?? "ws://localhost:4330/ws";
const MAX_ATTEMPTS = 30;

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
ws.on("error", (e) => { console.error("ws error:", e); process.exit(2); });

await new Promise<void>((r) => ws.once("open", () => r()));

await awaitFrame((s) => s === "h 1", "h 1");
await awaitFrame((s) => s.startsWith("c crt"), "c crt");
await awaitFrame((s) => s === "c ctr", "c ctr");
sendCommand("new");
await awaitFrame((s) => s.startsWith("c id "), "c id");
sendData("version", 35);
await awaitFrame((s) => /^d \d+ status\tlogin$/.test(s), "status login");
sendData("language", "en");
sendData("logintype", "nr");
await awaitFrame((s) => /^d \d+ status\tlogin$/.test(s), "status login (post-logintype)");
sendData("login");
await awaitFrame((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
await awaitFrame((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
sendData("lobbyselect", "select", 1);
await awaitFrame((s) => /^d \d+ status\tlobby\t1/.test(s), "status lobby 1");
await awaitFrame((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");

let attempt = 0;
let foundMagnet = false;
while (attempt++ < MAX_ATTEMPTS && !foundMagnet) {
    if (attempt === 1) {
        sendData("lobby", "cspt", 1, 0, 0); // category=ALL(1), tracks=1, water=0
    } else {
        // Skip current track to get the next random one. The single-track game
        // ends after a forfeit and we re-create. Simpler: just disconnect and
        // reconnect would double-loop; let's just request another single-shot.
        sendData("game", "back"); // back to lobby
        await awaitFrame((s) => /status\tlobby\t1/.test(s) || /lobby\townjoin/.test(s), "back to lobby", 5000).catch(() => null);
        sendData("lobby", "cspt", 1, 0, 0);
    }

    const startFrame = await awaitFrame((s) => /^d \d+ game\tstarttrack\t/.test(s), `starttrack#${attempt}`, 8000);
    const fields = startFrame.split("\t");
    const nField = fields.find((f) => f.startsWith("N "));
    const sField = fields.find((f) => f.startsWith("S "));
    const tField = fields.find((f) => f.startsWith("T "));
    if (!tField) continue;

    const name = nField?.slice(2) ?? "(unnamed)";
    const sBody = sField?.slice(2) ?? null;
    const flags = sBody === null ? ALL_VISIBLE_FLAGS : parseSettingsFlags(sBody);
    const map = decodeMap(tField.slice(2));

    let magnetCount = 0;
    let visibleAfterApply = 0;
    for (let y = 0; y < map.length; y++) {
        const row = map[y];
        for (let x = 0; x < row.length; x++) {
            const code = row[x];
            const u = unpackTile(code);
            // unpackTile.shape is the RAW byte (Java's shape - 24).
            // Magnets are raw 20/21; matches applySettingsToTileCode's check.
            if (u.isNoSpecial === 2 && (u.shape === 20 || u.shape === 21)) {
                magnetCount++;
                const after = applySettingsToTileCode(code, flags);
                if (after === code) visibleAfterApply++;
            }
        }
    }

    console.log(`[${attempt}] name=${JSON.stringify(name)} S=${sBody === null ? "(absent)" : JSON.stringify(sBody)} flags=${JSON.stringify(flags)} magnets=${magnetCount} stillVisible=${visibleAfterApply}`);
    if (magnetCount > 0) {
        if (visibleAfterApply === magnetCount) {
            console.log(`OK: ${magnetCount} magnets render visibly on "${name}"`);
            foundMagnet = true;
        } else {
            console.error(`FAIL: ${magnetCount - visibleAfterApply} of ${magnetCount} magnets are hidden on "${name}" (S=${JSON.stringify(sBody)})`);
            ws.close();
            process.exit(1);
        }
    }
}

if (!foundMagnet) {
    console.error(`FAIL: scanned ${MAX_ATTEMPTS} random tracks, none had magnets - inconclusive`);
    ws.close();
    process.exit(1);
}

ws.close();
process.exit(0);
