import { expect,it } from 'vitest';import { createProjectFixture } from '../testing/projects.js';import { createProjectDrafts } from './project-drafts.js';import { previewResolution } from '../projects/binding.js';
it('keeps unresolved filesystem drafts durable and rejects UI text mismatches',async()=>{
 const f=await createProjectFixture();try{const catalog={generation:'g',revision:'r',state:'ready' as const,projects:[]};
 const deps={localRoot:f.local,binding:{} as never,resolve:async(text:any,choices:any)=>previewResolution(text,catalog,choices)};
 const gate=await createProjectDrafts(deps),input={submissionId:'one',requestId:'one',filename:'one.md',markdown:'# [unknown] Change\n\nResearch'};
 expect(await gate.prepare(input)).toMatchObject({state:'needs-input'});expect((await gate.list())[0]).toMatchObject({submissionId:'one',revision:1});
 const reopen=await createProjectDrafts(deps);expect(await reopen.prepare(input)).toMatchObject({state:'needs-input'});expect(await reopen.list()).toHaveLength(1);
 const text={title:'Change',description:'Research'},choices={excludedReferenceIds:[],ambiguities:{}},p=await deps.resolve(text,choices),draft={text,choices,previewRevision:p.revision,catalogRevision:'r',selections:[]};
 await reopen.resolveIssue('one',1,draft,'fix');expect(await reopen.prepare(input)).toMatchObject({state:'ready',title:'Change',context:null});
 await expect(gate.prepare({...input,submissionId:'two',projectDraft:draft})).rejects.toMatchObject({code:'invalid'});
 }finally{await f.dispose();}
});
it('holds claimed filesystem bytes without creating a task, then resolves once across restart',async()=>{
 const {openStore}=await import('../store/task-store.js'),{createIntake}=await import('./intake.js'),{mkdir,writeFile}=await import('node:fs/promises'),{join}=await import('node:path');
 const f=await createProjectFixture();try{const catalog={generation:'g',revision:'r',state:'ready' as const,projects:[]},store=await openStore(f.workspace),gate=await createProjectDrafts({localRoot:f.local,binding:{} as never,resolve:async(t,c)=>previewResolution(t,catalog,c)});
 await mkdir(join(f.workspace,'drafts'),{recursive:true});await writeFile(join(f.workspace,'drafts','idea.md'),'# [missing] Investigate\n\nContext');
 const intake=createIntake(f.workspace,store,0,{},gate);await intake.scan(1);await intake.scan(2);expect((await store.list()).tasks).toHaveLength(0);
 const pending=(await gate.list())[0],text={title:'Investigate',description:'Context'},choices={excludedReferenceIds:[],ambiguities:{}},p=previewResolution(text,catalog,choices);
 await gate.resolveIssue(pending.submissionId,pending.revision,{text,choices,previewRevision:p.revision,catalogRevision:p.catalogRevision,selections:[]},'fix');
 await intake.scan(3);const first=(await store.list()).tasks;expect(first).toHaveLength(1);expect(first[0].title).toBe('Investigate');
 const reopened=createIntake(f.workspace,store,0,{},gate);await reopened.scan(4);expect((await store.list()).tasks).toEqual(first);
 }finally{await f.dispose();}
});
