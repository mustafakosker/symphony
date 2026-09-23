import { expect,it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectFixture,createRepository } from '../testing/projects.js';
import { scanRoot } from '../projects/discovery.js';
import { openProjectCatalog } from '../projects/catalog.js';
import { openSnapshots,resolveSourceCommit } from '../projects/snapshots.js';
import { resolveSnapshotAccess } from './snapshot-access.js';
import type { ProjectContext } from '../../shared/projects.js';
it('gives access only to selected verified snapshot files in separate project scope roots',async()=>{
 const f=await createProjectFixture();
 try{
  await createRepository(f.root,'one',{a:'One'});await createRepository(f.root,'two',{a:'Two'});
  const root={projectsRoot:f.root,generation:'g1',revision:'r1',state:'ready' as const,message:null};
  const cat=await openProjectCatalog(f.local),view=await cat.reconcile(root,await scanRoot(root,{timeoutMs:5000}));
  const snapshots=await openSnapshots(f.local,{entries:100,totalBytes:10000,fileBytes:10000,timeoutMs:5000});
  const context:ProjectContext={version:1,generation:'g1',resolutionRevision:'a'.repeat(64),targetId:null,referenceIds:view.records.map(p=>p.id),projects:[]};
  for(const p of view.records){const resolved=await resolveSourceCommit(p,'main');await snapshots.importCommit(p,resolved);context.projects.push({projectId:p.id,repositoryId:p.id,name:p.name,ref:'main',snapshot:await snapshots.materialize(p,resolved),brief:null});}
  const access=await resolveSnapshotAccess(context,context.referenceIds,snapshots);
  expect(access).toHaveLength(2);
  for(const entry of access)expect(entry.snapshotPath.startsWith(join(f.local,'projects/snapshots',entry.repository)+'/')).toBe(true);
  await expect(resolveSnapshotAccess(context,['foreign'],snapshots)).rejects.toThrow(/unbound/);
  await expect(resolveSnapshotAccess(context,[context.referenceIds[0],context.referenceIds[0]],snapshots)).rejects.toThrow(/duplicate/i);
  await rm(access[0].snapshotPath,{recursive:true});
  await expect(resolveSnapshotAccess(context,[context.referenceIds[0]],snapshots)).rejects.toThrow();
 }finally{await f.dispose();}
});
