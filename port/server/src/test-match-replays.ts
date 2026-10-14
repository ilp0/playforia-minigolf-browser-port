import type { Game } from './game.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
const root=mkdtempSync(join(tmpdir(),'match-replay-integration-'));
process.env.AAPELI_NATIVE_REPLAY_DIR=root;
const archive=await import('./match-replays.ts');
const legacy=await import('./replay-store.ts');
const record=archive.createMatchRecording(['Replay fixture'],{mode:'solo'});
const server=createServer((req,res)=>{if(!archive.handleMatchReplayApi(req,res)){res.writeHead(404);res.end();}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();if(!address || typeof address==='string')throw new Error('Address unavailable');
const base=`http://127.0.0.1:${address.port}`;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const pngBytes=Buffer.from(png.split(',')[1],'base64');
const body=JSON.stringify({frames:[{t:40,width:735,height:375,balls:[[0,100,100,13,13]],background:png,sprites:[png]}]});
const ballsOnly=(t:number)=>JSON.stringify({frames:[{t,balls:[[0,t,t,13,13]]}]});
const put=(id:string,name:string,token:string|null,payload:string)=>fetch(`${base}/api/replays/${id}/${name}`,{method:'PUT',headers:token?{Authorization:`Bearer ${token}`}:{},body:payload});
const meta=(id:string)=>JSON.parse(readFileSync(join(root,id,'meta.json'),'utf8'));
const withEnv=async(name:string,value:string,run:()=>Promise<void>)=>{const old=process.env[name];process.env[name]=value;try{await run();}finally{if(old===undefined)delete process.env[name];else process.env[name]=old;}};
const viewerShipped=existsSync(fileURLToPath(new URL('../../../../replays/viewer.html',import.meta.url)));
try {
 // Permanent chunks, idempotent retries, conflicts.
 assert.equal((await put(record.id,'0-0',record.token,body)).status,200);assert.equal((await put(record.id,'0-0',record.token,body)).status,200);
 assert.equal((await put(record.id,'0-1',null,body)).status,403);
 assert.equal((await put(record.id,'0-0',record.token,body.replace('40','41'))).status,400);
 await archive.flushMatchReplays();
 assert.equal(meta(record.id).writeHash,undefined);assert.match(meta(record.id).writeHashes['0'],/^[a-f0-9]{64}$/);
 assert.ok(!readFileSync(join(root,record.id,'meta.json'),'utf8').includes(record.token),'meta.json must hold only token hashes');

 // Per-view capabilities: a view-0 token can never write view 1, ungranted views are refused, re-granting revokes.
 assert.equal((await put(record.id,'1-0',record.token,ballsOnly(1))).status,403);
 assert.equal((await put(record.id,'99999-0',record.token,ballsOnly(1))).status,403);
 assert.equal((await put(record.id,'00-9',record.token,ballsOnly(1))).status,404);
 const view1=archive.grantReplayView(record.id,1);
 assert.equal((await put(record.id,'1-0',record.token,ballsOnly(1))).status,403);
 assert.equal((await put(record.id,'0-5',view1,ballsOnly(1))).status,403);
 assert.equal((await put(record.id,'1-0',view1,ballsOnly(1))).status,200);
 const view1Again=archive.grantReplayView(record.id,1);
 assert.equal((await put(record.id,'1-1',view1,ballsOnly(2))).status,403);
 assert.equal((await put(record.id,'1-1',view1Again,ballsOnly(2))).status,200);
 assert.equal((await put(record.id,'0-2',record.token,ballsOnly(3))).status,200);

 // PNG assets: full chunk structure with CRC32 and IEND, size cap.
 const badCrc=Buffer.from(pngBytes);badCrc[29]^=0xff;
 const withImage=(b:Buffer)=>JSON.stringify({frames:[{t:50,balls:[],background:'data:image/png;base64,'+b.toString('base64')}]});
 assert.equal((await put(record.id,'0-3',record.token,withImage(badCrc))).status,400);
 assert.equal((await put(record.id,'0-3',record.token,withImage(pngBytes.subarray(0,pngBytes.length-12)))).status,400,'missing IEND');
 const trailing=Buffer.concat([pngBytes,Buffer.from('junk')]);
 assert.equal((await put(record.id,'0-3',record.token,withImage(trailing))).status,400,'data after IEND');
 const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length,0);head.write(type,4,'latin1');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])),0);return Buffer.concat([head,data,crc]);};
 const ihdrEnd=8+25;const padded=Buffer.concat([pngBytes.subarray(0,ihdrEnd),chunk('tEXt',Buffer.alloc(1024*1024+10,97)),pngBytes.subarray(ihdrEnd)]);
 assert.equal((await put(record.id,'0-3',record.token,withImage(padded))).status,413,'oversized asset');
 const legit=Buffer.concat([pngBytes.subarray(0,ihdrEnd),chunk('tEXt',Buffer.from('Comment\0ok')),pngBytes.subarray(ihdrEnd)]);
 assert.equal((await put(record.id,'0-3',record.token,withImage(legit))).status,200,'valid PNG with an ancillary chunk');

 // Byte and chunk caps.
 await withEnv('AAPELI_REPLAY_MAX_VIEW_BYTES','600',async()=>{
  assert.equal((await put(record.id,'1-2',view1Again,JSON.stringify({frames:Array.from({length:200},(_,i)=>({t:i,balls:[[i,Math.random(),Math.random()]]}))}))).status,413);
 });
 await withEnv('AAPELI_REPLAY_MAX_CHUNKS','5',async()=>{
  assert.equal((await put(record.id,'1-3',view1Again,ballsOnly(4))).status,413);
 });

 // Events: private chat excluded, then nothing after the match ends.
 archive.matchEvent(record,'game\tbeginstroke\tcoordinates');archive.matchEvent(record,'game\tsay\tprivate chat');
 archive.finishMatchRecording(record);
 archive.matchEvent(record,'game\tbeginstroke\tafter-end');
 archive.finishMatchRecording(record,'abandoned');
 await archive.flushMatchReplays();
 const events=readFileSync(join(root,record.id,'events.jsonl'),'utf8');
 assert.ok(events.includes('coordinates'));assert.ok(!events.includes('private chat'));assert.ok(!events.includes('after-end'));
 assert.equal(meta(record.id).state,'completed','second finish must not overwrite the first');

 // Late uploads: accepted within the end grace, rejected after it.
 assert.equal((await put(record.id,'0-4',record.token,ballsOnly(5))).status,200);
 await withEnv('AAPELI_REPLAY_END_GRACE_MS','0',async()=>{
  await new Promise(r=>setTimeout(r,5));
  assert.equal((await put(record.id,'0-5',record.token,ballsOnly(6))).status,409);
 });
 const stale=archive.createMatchRecording(['Stale'],{mode:'solo'});
 await withEnv('AAPELI_REPLAY_MAX_AGE_MS','0',async()=>{
  await new Promise(r=>setTimeout(r,5));
  assert.equal((await put(stale.id,'0-0',stale.token,ballsOnly(1))).status,409);
 });
 assert.equal((await put('0123456789abcdef0123456789abcdef','0-0',stale.token,ballsOnly(1))).status,404);

 const info=await (await fetch(`${base}/api/replays/${record.id}`)).json() as {state:string;chunks:string[];writeHashes?:unknown};
 assert.equal(info.state,'completed');assert.deepEqual(info.chunks,['0-0','0-2','0-3','0-4','1-0','1-1']);assert.equal(info.writeHashes,undefined);assert.equal((info as any).owners,undefined);
 assert.match(record.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 const saved=await (await fetch(`${base}/api/replays/${record.id}/0-0`)).json() as {frames:{background:string;balls:number[][]}[]};
 assert.deepEqual(saved.frames[0].balls,[[0,100,100,13,13]]);
 const image=await fetch(base+saved.frames[0].background);assert.equal(image.headers.get('content-type'),'image/png');
 assert.ok(Buffer.from(await image.arrayBuffer()).equals(pngBytes));
 assert.equal(readdirSync(join(root,'assets')).filter(n=>n.endsWith('.png')).length,2);
 // Assets are shared on disk but only readable through a recording that stored them.
 assert.equal((await fetch(base+saved.frames[0].background.replace(record.id,stale.id))).status,404);
 const timeline=await (await fetch(`${base}/api/replays/${record.id}/timeline/0`)).text();assert.deepEqual(JSON.parse(timeline.trim().split('\n')[0]).frames[0].balls,[[0,100,100,13,13]]);
 assert.equal(readFileSync(join(root,record.id,'0-0.json'))[0],31);

 // Daily share store: survives a restart, bounded with oldest-first eviction.
 const share=legacy.saveReplay('{"v":1,"d":"2026-10-14"}');
 const code=`import {getReplay} from ${JSON.stringify(new URL('./replay-store.ts',import.meta.url).href)};process.stdout.write(getReplay(${JSON.stringify(share)}));`;
 assert.equal(execFileSync(process.execPath,['--experimental-strip-types','--no-warnings','--input-type=module','-e',code],{encoding:'utf8'}),'{"v":1,"d":"2026-10-14"}');
 legacy._clearReplayStore({maxEntries:3,maxBytes:64*1024});
 const shares=Array.from({length:5},(_,i)=>legacy.saveReplay(JSON.stringify({i})));
 assert.deepEqual(shares.map(id=>legacy.getReplay(id)!==null),[false,false,true,true,true]);
 const big=Array.from({length:3},()=>legacy.saveReplay('x'.repeat(40*1024)));
 assert.deepEqual(big.map(id=>legacy.getReplay(id)!==null),[false,false,true]);
 legacy._disposeReplayStores();

 if(viewerShipped){
  assert.equal((await fetch(`${base}/replays/?id=${record.id}`)).status,200);
  const css=await fetch(`${base}/replays.css`);assert.equal(css.status,200);assert.ok(css.headers.get('content-type')?.startsWith('text/css'));assert.ok((await css.text()).includes('.original-replay-frame'));
  const embedded=await fetch(`${base}/replays/embed?id=${record.id}`);assert.equal(embedded.status,200);const embeddedHtml=await embedded.text();assert.ok(embeddedHtml.includes('replay-embedded'));assert.ok(!embeddedHtml.includes('profile-header.js'));
 } else console.log('SKIP: shared replay viewer files are not part of this checkout');
 const descriptor=await (await fetch(base+'/replay-client.json')).json() as {kind:string;build:string};assert.equal(descriptor.kind,'minigolf-native');
 const commands=[{t:0,packet:'game\tstart',local:false}];
 const simulation=archive.createMatchRecording(['Simulation fixture'],{mode:'solo'});
 const saveCommands=(value:unknown)=>put(simulation.id,'0-0',simulation.token,JSON.stringify(value));
 assert.equal((await saveCommands({frames:[],commands,engine:descriptor})).status,200);
 assert.equal((await fetch(`${base}/api/replays/${simulation.id}/client/index.html`)).status,200);
 assert.equal((await put(simulation.id,'0-1',simulation.token,JSON.stringify({frames:[],commands:[{t:0,packet:'game\tsay\tprivate chat',local:false}],engine:descriptor}))).status,400);

 // Exercise the actual server reattachment path: a resync is not a new match.
 const {GolfGame}=await import('./game.ts');
 const scoreFixture=Object.assign(Object.create(GolfGame.prototype),{playerStrokesTotal:[12],playerStrokesThisTrack:[4],currentTrack:2,tracks:[{},{}]});
 assert.equal(scoreFixture.replayStrokes(0),12);scoreFixture.currentTrack=1;assert.equal(scoreFixture.replayStrokes(0),16);
 const {Connection}=await import('./connection.ts');
 const {GolfServer}=await import('./server.ts');
 const {TrackManager}=await import('./tracks.ts');
 const {Player}=await import('./player.ts');
 const golf=new GolfServer(new TrackManager());
 const messages:string[]=[];
 const connection=(): import('./connection.ts').Connection => Object.assign(Object.create(Connection.prototype) as import('./connection.ts').Connection,
   {clientId:null,connId:'replay-test',player:null,outSeq:0,matchRecording:null,replayResuming:false,portalIdentity:null,sendRaw:(line:string)=>messages.push(line)});
 const before=connection(),after=connection();
 const player=new Player(before,123);player.nick='Resume fixture';before.player=player;
 player.game={name:'Test room',getPlayerId:()=>2,getPlayers:()=>[player],sendReconnectResync:()=>player.connection.sendDataRaw('game\tstart')} as unknown as Game;
 golf.addPlayer(player);before.sendDataRaw('game\tstart');
 const original=before.matchRecording!;player.disconnectedAt=Date.now();
 const announced=JSON.parse(messages.find(m=>m.startsWith('r replay {'))!.slice('r replay '.length));
 assert.deepEqual(Object.keys(announced).sort(),['elapsed','id','started','token','view']);
 assert.equal(announced.view,2,'the capability is bound to the server-known slot');
 assert.equal((await put(original.id,'0-0',announced.token,ballsOnly(1))).status,403);
 assert.equal((await put(original.id,'2-0',announced.token,ballsOnly(1))).status,200);
 assert.equal(golf.handleReconnect(after,player.id),true);
 assert.equal(after.matchRecording?.id,original.id);assert.equal(before.matchRecording,null);
 await archive.flushMatchReplays();
 assert.equal(meta(original.id).state,'playing');
 messages.length=0;
 after.finishReplay();after.finishReplay();
 assert.equal(messages.filter(m=>m==='r replay-end').length,1,'replay-end is sent once');
 assert.equal(after.matchRecording,null);
 after.sendDataRaw('game\tbeginstroke\tlate');
 await archive.flushMatchReplays();
 assert.equal(meta(original.id).state,'completed');
 assert.ok(!readFileSync(join(root,original.id,'events.jsonl'),'utf8').includes('late'));
 player.game=null;player.disconnectedAt=Date.now();const lobbyReconnect=connection();
 assert.equal(golf.handleReconnect(lobbyReconnect,player.id),true);
 lobbyReconnect.sendDataRaw('game\tstart');assert.notEqual(lobbyReconnect.matchRecording?.id,original.id);

 // Archive-wide capacity: total size cap answers 507.
 const full=archive.createMatchRecording(['Full'],{mode:'solo'});
 await withEnv('AAPELI_REPLAY_MAX_BYTES','1',async()=>{assert.equal((await put(full.id,'0-0',full.token,ballsOnly(1))).status,507);});
 await withEnv('AAPELI_REPLAY_MIN_FREE_BYTES',String(Number.MAX_SAFE_INTEGER),async()=>{assert.equal((await put(full.id,'0-0',full.token,ballsOnly(1))).status,507);});
 assert.equal((await put(full.id,'0-0',full.token,ballsOnly(1))).status,200);
 await archive.flushMatchReplays();
 console.log('PASS: per-view capabilities, upload windows, byte and chunk caps, PNG validation, asset scoping, share eviction, idempotent finish, and viewer HTTP');
}finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));rmSync(root,{recursive:true,force:true});}
process.exit(0);
