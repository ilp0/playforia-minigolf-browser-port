/** Permanent Daily Cup share payloads. Existing IDs and URLs remain compatible. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
let root = path.join(process.env.AAPELI_NATIVE_REPLAY_DIR || fileURLToPath(new URL('../../../../replays/private/native/',import.meta.url)), 'daily-shares');
export function saveReplay(payload: string): string {
    if(Buffer.byteLength(payload)>64*1024)throw new Error('Replay payload too large');
    mkdirSync(root,{recursive:true});
    let id:string;
    do {id=randomUUID();}while(existsSync(path.join(root,id+'.json')));
    // New files only: a full filesystem never removes an older replay.
    const fd=openSync(path.join(root,id+'.json'),'wx');
    try {writeFileSync(fd,payload);fsyncSync(fd);}finally {closeSync(fd);}
    return id;
}
export function getReplay(id:string):string|null {
    if(!/^(?:[a-z0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(id))return null;
    try{return readFileSync(path.join(root,id+'.json'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
/** Tests switch to an empty temporary namespace, preserving real archives. */
export function _clearReplayStore():void {root=mkdtempSync(path.join(tmpdir(),'golf-replay-test-'));}
