import { expect,it } from 'vitest';import { createServer } from 'node:http';import { writeFile } from 'node:fs/promises';import { createProjectFixture } from '../testing/projects.js';import { loadSettings } from '../config/settings.js';import { openStore } from '../store/task-store.js';import { openProjectServices } from '../projects/service.js';import { createIntake } from '../intake/intake.js';import { createApi } from './api.js';
it('exposes only project settings and rejects unsafe/stale HTTP mutations',async()=>{
 const f=await createProjectFixture();let server:ReturnType<typeof createServer>|undefined;try{await writeFile(f.configPath,JSON.stringify({workspaceRoot:f.workspace,localRoot:f.local,codexBinary:process.execPath}));const settings=await loadSettings(f.configPath),store=await openStore(f.workspace),projects=await openProjectServices(f.configPath,settings,store);
 server=createServer(createApi({store,intake:createIntake(f.workspace,store,0,{},projects.draftGate),projects,coordinator:{tick:async()=>{},stopTask:async()=>{},shutdown:async()=>{}},allowedOrigin:'http://127.0.0.1:4317'}));await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
 const post=(path:string,data:unknown,origin='http://127.0.0.1:4317')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(data)});
 const root=await (await fetch(base+'/api/settings/projects')).json();expect(Object.keys(root).sort()).toEqual(['generation','message','projectsRoot','revision','state']);
 expect((await post('/api/settings/projects',{projectsRoot:f.root,expectedRevision:root.revision,requestId:'save',sourcePath:'/tmp'})).status).toBe(400);
 expect((await post('/api/projects/rescan',{requestId:'scan'},'https://untrusted.invalid')).status).toBe(403);
 expect((await post('/api/settings/projects',{projectsRoot:f.root,expectedRevision:'stale',requestId:'stale'})).status).toBe(409);
 expect((await post('/api/settings/projects',{projectsRoot:f.root,expectedRevision:root.revision,requestId:'save'})).status).toBe(200);
 expect((await fetch(base+'/api/projects/missing')).status).toBe(404);
 expect((await post('/api/projects/resolve',{text:{title:'Test',description:''},choices:{excludedReferenceIds:[],ambiguities:{}}})).status).toBe(200);
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await f.dispose();}
});
