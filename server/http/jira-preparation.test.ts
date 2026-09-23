import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/task-store';
import { jiraTask } from '../preparation/testing';
import { createPreparationService } from '../preparation/service';
import { createMockOnaAdapter } from '../ona/mock';
import { createApi } from './api';
import { createIntake } from '../intake/intake';
let root:string,server:Server,base:string,store:Store;
const origin='http://127.0.0.1:4317';
const view={enabled:true,simulated:true as const,syncing:false,lastSuccessAt:null,error:null};
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'jira-http-')); store=await openStore(root); await store.create(jiraTask(),'create');
 const preparation=createPreparationService({store,registry:{projects:[],roles:[]},adapter:createMockOnaAdapter({localRoot:root}),localRoot:root});
 server=createServer(createApi({store,intake:createIntake(root,store,0),coordinator:{tick:async()=>{},stopTask:async()=>{},shutdown:async()=>{}},allowedOrigin:origin,
 preparation,jira:{view:()=>view,sync:async()=>view,tick:async()=>{}},targets:[]}));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});});
const uploadUrl=()=>`${base}/api/tasks/${jiraTask().id}/documents/design`;
const headers=(overrides={})=>({'Content-Type':'application/octet-stream',Origin:origin,'X-Symphony-Request-Id':'upload','X-Symphony-Expected-Revision':'1','X-Symphony-Filename':'design.md',...overrides});
it('bounds chunked raw uploads by actual bytes and preserves accepted content', async()=>{
 for(const size of [1024*1024+1,1024*1024]) {
 const status=await new Promise<number>((resolve,reject)=>{const req=request(uploadUrl(),{method:'POST',headers:headers()},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);for(let i=0;i<size;i+=65536)req.write(Buffer.alloc(Math.min(65536,size-i),97));req.end();});
 expect(status).toBe(size===1024*1024?200:413);
 }
 const task=await store.get(jiraTask().id); expect(task.preparation!.documents.design!.size).toBe(1024*1024);
});
it('validates origin, filename, roles and task binding before selecting bytes',async()=>{
 for(const changes of [{Origin:''},{Origin:'https://foreign.test'},{'X-Symphony-Filename':'%ZZ'},{'X-Symphony-Filename':'..%2Fdesign.md'}]) {
  const res=await fetch(uploadUrl(),{method:'POST',headers:headers(changes),body:'design'});expect(res.status).toBe(changes.Origin!==undefined?403:400);
 }
 expect((await fetch(uploadUrl().replace('/design','/other'),{method:'POST',headers:headers(),body:'design'})).status).toBe(404);
 const res=await fetch(`${base}/api/tasks/${jiraTask().id}/preparation/commands`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({taskId:'other',requestId:'prepare',expectedRevision:1,action:{kind:'prepare'}})});
 expect(res.status).toBe(400);expect((await store.get(jiraTask().id)).artifacts).toHaveLength(0);
});
it('does not select a truncated body',async()=>{
 await new Promise<void>(resolve=>{const req=request(uploadUrl(),{method:'POST',headers:headers({'Content-Length':'20'})});req.on('error',()=>resolve());req.write('short');setTimeout(()=>req.destroy(),10);});
 expect((await store.get(jiraTask().id)).artifacts).toHaveLength(0);
});
it('returns feature status and supports preparation and exact artifact downloads',async()=>{
 const response=await fetch(uploadUrl(),{method:'POST',headers:headers(),body:Buffer.from('\uFEFF# Café\r\n')});expect(response.status).toBe(200);
 const task=await response.json(),ref=task.preparation.documents.design.ref;
 const artifact=await fetch(`${base}/api/tasks/${task.id}/artifacts/${ref.id}?version=${ref.version}`);
 expect(Buffer.from(await artifact.arrayBuffer())).toEqual(Buffer.from('\uFEFF# Café\r\n'));expect(artifact.headers.get('Content-Security-Policy')).toContain('sandbox');
 expect((await (await fetch(`${base}/api/workspace`)).json()).jira.simulated).toBe(true);
 expect((await fetch(`${base}/api/tasks/${task.id}/preparation`)).status).toBe(200);
});
