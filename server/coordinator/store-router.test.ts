import { expect,it } from 'vitest';
import { join } from 'node:path';
import { createProjectFixture,projectContextFixture } from '../testing/projects.js';
import { draftTask } from '../testing/fixtures.js';
import { openStore } from '../store/task-store.js';
import { createStoreRouter } from './store-router.js';
it('isolates internal jobs from the public task store and rejects duplicate IDs',async()=>{
 const f=await createProjectFixture();try{
 const primary=await openStore(f.workspace),jobs=await openStore(join(f.local,'jobs')),router=createStoreRouter(primary,jobs);
 const context=projectContextFixture();context.targetId=null;context.referenceIds=['project'];context.projects[0].brief=null;
 const job={...draftTask(),schemaVersion:2 as const,purpose:'project-brief' as const,projectContext:context};
 await router.create(job,'job');expect((await primary.list()).tasks).toEqual([]);expect((await router.list()).tasks[0].id).toBe(job.id);
 await expect(primary.get(job.id)).rejects.toMatchObject({code:'missing'});
 await expect(router.create(draftTask(),'collision')).rejects.toThrow(/duplicate/i);
 expect(await createStoreRouter(await openStore(f.workspace),await openStore(join(f.local,'jobs'))).get(job.id)).toEqual(job);
 }finally{await f.dispose();}
});
