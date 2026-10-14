/** Durable, observation-based match replays, compatible with games/replays/archive.py. */
import { configureReplayIndex, queueReplayIndex } from './replay-profile-index.ts';
import type { PortalConfig } from './portal.ts';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync, gunzip } from 'node:zlib';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, fsyncSync, closeSync, linkSync, unlinkSync, appendFileSync, existsSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
const root = process.env.AAPELI_NATIVE_REPLAY_DIR || fileURLToPath(new URL('../../../../replays/private/native/', import.meta.url));
const assets = fileURLToPath(new URL('../../../../replays/', import.meta.url));
const idRE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/, chunkRE = /^[0-9]{1,5}-[0-9]{1,8}$/;
const dist=fileURLToPath(new URL('../../web/dist/',import.meta.url));
const simulationCommands=new Set('practiceballs toplist gameinfo player players owninfo join part start starttrack turn startturn beginstroke setwhiteball setpainted specball specdata specscore end changescore resetvoteskip voteskip readyfornewgame rfng timeout concede practicemode dailymode snapapply endstroke'.split(' '));
function validCommand(c:any):boolean {if(!c||!Number.isFinite(c.t)||c.t<0||c.t>86400000||typeof c.local!=='boolean'||typeof c.packet!=='string'||Buffer.byteLength(c.packet)>32768||/[\r\n\0]/.test(c.packet))return false;const f=c.packet.split('\t');return f.length>=2&&(f[0]==='game'&&simulationCommands.has(f[1])||!c.local&&(['basicinfo','coininfo'].includes(f[0])||f[0]==='status'&&f[1]==='game'));}
let clientBuild:string|null=null;
function snapshotClient():{kind:string;build:string}{
    if(!clientBuild){const hash=createHash('sha256');const walk=(folder:string)=>{for(const name of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(folder,name.name);if(name.isDirectory())walk(file);else {hash.update(path.relative(dist,file));hash.update(readFileSync(file));}}};walk(dist);clientBuild=hash.digest('hex');
        const target=path.join(root,'clients','minigolf-native',clientBuild);if(!existsSync(target)){mkdirSync(path.dirname(target),{recursive:true});const tmp=target+'.tmp';cpSync(dist,tmp,{recursive:true});renameSync(tmp,target);}
    }return {kind:'minigolf-native',build:clientBuild};
}
const active = new Set<string>();
const digest = (s:string) => createHash('sha256').update(s).digest('hex');
export interface MatchRecording {id:string; token:string; started:number;}
function metadata(id:string): Record<string,unknown> {if(!idRE.test(id))throw new Error('not-found');return JSON.parse(readFileSync(path.join(root,id,'meta.json'),'utf8'));}
function atomic(file:string,body:string|Buffer):void {
    const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
    const fd=openSync(tmp,'wx');try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(tmp,file);
}
export function configureMatchReplayPortal(config:PortalConfig|null):void {configureReplayIndex(config,root,atomic);}
export function createMatchRecording(players:string[],settings:Record<string,unknown>,owner?:string):MatchRecording {
    const id=randomUUID(),token=randomBytes(32).toString('hex'),started=Date.now();
    mkdirSync(path.join(root,id),{recursive:true});
    const meta={v:1,id,game:'minigolf-native',players,settings,started,state:'playing',writeHash:digest(token),owners:owner?{[owner]:0}:{}};
    atomic(path.join(root,id,'meta.json'),JSON.stringify(meta));
    queueReplayIndex(meta,atomic);
    active.add(id);
    return {id,token,started};
}
export function finishMatchRecording(record:MatchRecording,state='completed',score?:Record<string,unknown>):void {
    active.delete(record.id);
    const meta=metadata(record.id);if(meta.state !== 'playing')return;
    const finished={...meta,state,ended:Date.now(),scores:score?{'0':score}:meta.scores};
    atomic(path.join(root,record.id,'meta.json'),JSON.stringify(finished));
    queueReplayIndex(finished,atomic);
}
const recorded = new Set(['start','starttrack','beginstroke','endstroke','end','startturn','turn','players','owninfo','join','part','snapapply','practicemode','dailymode']);
export function matchEvent(record:MatchRecording,body:string):void {
    const fields=body.split('\t').slice(1);if(!recorded.has(fields[0]))return;
    appendFileSync(path.join(root,record.id,'events.jsonl'),JSON.stringify({t:Date.now(),fields})+'\n');
}
function asset(id:string,source:string,sprite=false):string {
    const data=Buffer.from(source.slice('data:image/png;base64,'.length),'base64');
    if(data.length<24 || !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('invalid PNG');
    const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
    if(width<1||width>(sprite?64:1000)||height<1||height>(sprite?64:700))throw new Error('invalid PNG dimensions');
    const hash=createHash('sha256').update(data).digest('hex'),folder=path.join(root,'assets'),file=path.join(folder,hash+'.png');
    mkdirSync(folder,{recursive:true});
    if(!existsSync(file))atomic(file,data);
    return `/api/replays/${id}/assets/${hash}`;
}
function readChunk(id:string,name:string):Buffer {
    const data=readFileSync(path.join(root,id,name+'.json'));
    return data[0]===31 && data[1]===139 ? gunzipSync(data):data;
}
const decompress=promisify(gunzip);
async function streamTimeline(id:string,view:string,res:ServerResponse,head:boolean):Promise<void> {
    const names=readdirSync(path.join(root,id)).filter(x=>chunkRE.test(x.replace(/\.json$/,'')) && x.startsWith(view+'-')).sort((a,b)=>Number(a.split('-')[1].split('.')[0])-Number(b.split('-')[1].split('.')[0]));
    res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(!head)for(const name of names){
        if(res.destroyed)break;
        const packed=await readFile(path.join(root,id,name));
        const data=packed[0]===31 && packed[1]===139 ? await decompress(packed):packed;
        if(!res.write(Buffer.concat([data,Buffer.from('\n')]))){await new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}
    }
    res.end();
}
export function handleMatchReplayApi(req:IncomingMessage,res:ServerResponse):boolean {
    const url=new URL(req.url||'/', 'http://localhost'),p=url.pathname;
    if(!p.startsWith('/api/replays/') && !['/replays','/replays/','/replays/embed','/replay-recorder.js','/replay-viewer.js','/replay-language.js','/client-replay.js','/replay-client.json','/replays.css'].includes(p))return false;
    const respond=(code:number,body:string|Buffer,mime='application/json')=>{res.writeHead(code,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:body);};
    try {
        if(p==='/replay-client.json'&&['GET','HEAD'].includes(req.method||'')){respond(200,JSON.stringify(snapshotClient()));return true;}
        if(!p.startsWith('/api/replays/')) {
            if(!['GET','HEAD'].includes(req.method||'')){respond(404,'{}');return true;}
            const name=p==='/replays/embed'?'embed.html':['/replays','/replays/'].includes(p)?'viewer.html':p.slice(1);
            respond(200,readFileSync(p==='/replays.css'?path.resolve(assets,'../../web/replays.css'):path.join(assets,name)),name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return true;
        }
        const [id,name,...rest]=p.slice('/api/replays/'.length).split('/');
        if(idRE.test(id)&&name==='client'&&rest.length&&rest.every(x=>/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(x))&&['GET','HEAD'].includes(req.method||'')){
            const meta=metadata(id);const engine=meta.engine as {kind:string;build:string};const file=path.join(root,'clients',engine.kind,engine.build,...rest);let body=readFileSync(file);const ext=path.extname(file);const mime=({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.gif':'image/gif','.jpg':'image/jpeg','.xml':'application/xml','.json':'application/json'} as Record<string,string>)[ext];if(!mime){respond(404,'{}');return true;}
            const prefix='/api/replays/'+id+'/client';if(ext==='.html')body=Buffer.from(body.toString().replace(/(src|href)="\/(?!replay-language|replay-recorder|client-replay)/g,'$1="'+prefix+'/'));if(ext==='.css')body=Buffer.from(body.toString().replace(/([("'])\/picture\//g,'$1'+prefix+'/picture/'));
            respond(200,body,mime);return true;
        }
        if(idRE.test(id) && name==='timeline'  && rest.length===1 && /^[0-9]{1,5}$/.test(rest[0]) && ['GET','HEAD'].includes(req.method||'')){metadata(id);void streamTimeline(id,rest[0],res,req.method==='HEAD').catch(()=>res.destroy());return true;}
        if(idRE.test(id) && name==='assets' && rest.length===1 && /^[a-f0-9]{64}$/.test(rest[0]) && ['GET','HEAD'].includes(req.method||'')) {metadata(id);respond(200,readFileSync(path.join(root,'assets',rest[0]+'.png')),'image/png');return true;}
        if(rest.length || !idRE.test(id) || (name && !chunkRE.test(name))){respond(404,'{}');return true;}
        const meta=metadata(id);
        if(req.method==='PUT' && name) {
            const token=(req.headers.authorization||'').replace(/^Bearer /,'');
            if(!timingSafeEqual(Buffer.from(digest(token)),Buffer.from(String(meta.writeHash)))){respond(403,'{}');return true;}
            const buffers:Buffer[]=[];let total=0,failed=false;
            req.setTimeout(15000,()=>req.destroy());
            req.on('data',(b:Buffer)=>{total+=b.length;if(total>2*1024*1024){failed=true;respond(413,'{}');req.destroy();}else buffers.push(b);});
            req.on('end',()=>{if(failed)return;try{
                let body=Buffer.concat(buffers);const chunk=JSON.parse(body.toString());
                const commands=chunk.commands||[];if(!Array.isArray(commands)||commands.length>1000||commands.some((c:unknown)=>!validCommand(c)))throw new Error('invalid commands');
                if(!Array.isArray(chunk.frames)||(!chunk.frames.length&&!commands.length)||chunk.frames.length>1000)throw new Error('invalid');
                if(chunk.engine){const engine=chunk.engine;const current=metadata(id);if(engine.kind!=='minigolf-native'||typeof engine.build!=='string'||!/^[a-f0-9]{64}$/.test(engine.build)||!existsSync(path.join(root,'clients','minigolf-native',engine.build))||current.engine&&JSON.stringify(current.engine)!==JSON.stringify(engine))throw new Error('invalid client');if(!current.engine){current.engine=engine;atomic(path.join(root,id,'meta.json'),JSON.stringify(current));}}
                const originalFile=path.join(root,id,name+'.json');
                if(existsSync(originalFile) && JSON.stringify(JSON.parse(readChunk(id,name).toString()))===JSON.stringify(chunk)){respond(200,'{"saved":true}');return;}
                for(const f of chunk.frames){if(!Number.isFinite(f.t)||f.t<0||f.t>86400000||!Array.isArray(f.balls)||f.balls.length>256)throw new Error('invalid');
                    if(f.background && (typeof f.background!=='string'||!f.background.startsWith('data:image/png;base64,')))throw new Error('invalid');
                    if(f.sprites && (!Array.isArray(f.sprites)||f.sprites.length>64||f.sprites.some((s:unknown)=>typeof s!=='string'||!s.startsWith('data:image/png;base64,'))))throw new Error('invalid');}
                for(const f of chunk.frames){if(f.background)f.background=asset(id,f.background);if(f.sprites)f.sprites=f.sprites.map((s:string)=>asset(id,s,true));}
                body=Buffer.from(JSON.stringify(chunk));
                const file=path.join(root,id,name+'.json');
                try{const old=readChunk(id,name);if(!old.equals(body))throw new Error('conflict');respond(200,'{"saved":true}');return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
                if(readdirSync(path.join(root,id)).length>100000)throw new Error('capacity');
                const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';const fd=openSync(tmp,'wx');try{writeFileSync(fd,gzipSync(body));fsyncSync(fd);}finally{closeSync(fd);}
                try{linkSync(tmp,file);}finally{unlinkSync(tmp);}respond(200,'{"saved":true}');
            }catch(e){respond((e as NodeJS.ErrnoException).code==='ENOSPC'?507:400,'{"error":"Replay write failed"}');}});
        } else if(['GET','HEAD'].includes(req.method||'')) {
            if(name)respond(200,readChunk(id,name));
            else {delete meta.writeHash;delete meta.owners;if(meta.state==='playing'&&!active.has(id))meta.state='interrupted';meta.chunks=readdirSync(path.join(root,id)).filter(x=>chunkRE.test(x.replace(/\.json$/,''))).map(x=>x.replace(/\.json$/,'')).sort();respond(200,JSON.stringify(meta));}
        }else respond(404,'{}');
    }catch(e){respond((e as NodeJS.ErrnoException).code==='ENOENT'?404:507,'{"error":"Replay unavailable"}');}
    return true;
}
