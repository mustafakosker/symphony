import { expect,it } from 'vitest';
import { createProjectFixture,createRepository,treeDigest } from '../testing/projects.js';
import { scanRoot } from './discovery.js';import { openProjectCatalog } from './catalog.js';import { openSnapshots,resolveSourceCommit } from './snapshots.js';
import { openBriefs } from './briefs.js';
it('versions briefs immutably, replays saves, and preserves edits on stale writes',async()=>{
 const f=await createProjectFixture();try{
 await createRepository(f.root,'shop',{a:'A'});const root={projectsRoot:f.root,generation:'g1',revision:'r1',state:'ready' as const,message:null};
 const cat=await openProjectCatalog(f.local),p=(await cat.reconcile(root,await scanRoot(root,{timeoutMs:5000}))).records[0];
 const snapshots=await openSnapshots(f.local,{entries:100,totalBytes:10000,fileBytes:10000,timeoutMs:5000}),resolved=await resolveSourceCommit(p,'main');await snapshots.importCommit(p,resolved);const source=await snapshots.materialize(p,resolved);
 const before=await treeDigest(f.root),briefs=await openBriefs(f.local,snapshots);
 const input={projectId:p.id,expectedVersion:null,requestId:'first',author:'human' as const,source,report:{format:'source-report-v1' as const,text:'Architecture and commands. Not run.',citations:[]}};
 const first=await briefs.save(input);expect(first.version).toBe(1);
 const second=await briefs.save({...input,expectedVersion:1,requestId:'second',author:'human-edited',report:{...input.report,text:'Edited context'}});
 expect(second.version).toBe(2);expect(await briefs.save(input)).toEqual(first);
 await expect(briefs.save({...input,requestId:'stale'})).rejects.toMatchObject({code:'conflict'});
 expect(await (await openBriefs(f.local,snapshots)).current(p.id)).toEqual(second);
 expect(await briefs.get(p.id,1)).toEqual(first);expect(await treeDigest(f.root)).toBe(before);
 await expect(briefs.save({...input,projectId:'other',requestId:'forged'})).rejects.toThrow();
 }finally{await f.dispose();}
});
