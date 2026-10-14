/** Persistent, retryable portal indexing. Ownership comes only from verified WS identities. */
import { mkdirSync, readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import type { PortalConfig } from './portal.ts';
import * as path from 'node:path';
let config:PortalConfig|null=null, running=false;
let directory='';
export function configureReplayIndex(cfg:PortalConfig|null,root:string,atomic:(file:string,body:string)=>void):void {
    config=cfg;directory=path.join(root,'profile-outbox');
    if(existsSync(directory))for(const name of readdirSync(directory).filter(n=>n.endsWith('.json'))){const file=path.join(directory,name);try{const meta=JSON.parse(readFileSync(file,'utf8'));if(meta.state==='playing')atomic(file,JSON.stringify({...meta,state:'interrupted',ended:Date.now()}));}catch{}}
    if(cfg){setInterval(()=>void publish(),30000).unref();void publish();}
}
export function queueReplayIndex(meta:Record<string,any>,atomic:(file:string,body:string)=>void):void {
    if(!directory||!meta.owners||!Object.keys(meta.owners).length)return;
    const out=path.join(directory,meta.id+'.json');
    mkdirSync(path.dirname(out),{recursive:true});
    atomic(out,JSON.stringify({id:meta.id,game:meta.game,mode:meta.settings.mode,started:meta.started,ended:meta.ended??null,state:meta.state,owners:Object.entries(meta.owners).map(([profileId,view])=>({profileId,score:meta.scores?.[String(view)]||{}}))}));
    void publish();
}
async function publish():Promise<void> {
    if(running||!config||!existsSync(directory))return;
    running=true;
    try{for(const name of readdirSync(directory).filter(n=>n.endsWith('.json'))){
        const file=path.join(directory,name);
        try{const body=readFileSync(file,'utf8');const response=await fetch(config.internalUrl+'/internal/replay',{method:'POST',headers:{Authorization:'Bearer '+config.key,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(5000),redirect:'error'});
            if(response.ok&&JSON.parse(body).state!=='playing'&&readFileSync(file,'utf8')===body)unlinkSync(file);
        }catch{/* Durable outbox retries on the next pass. */}
    }}finally{running=false;}
}
