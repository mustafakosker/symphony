import { afterEach,expect,it } from 'vitest';
import { createProjectFixture,createRepository } from '../testing/projects.js';
import { scanRoot } from './discovery.js';import { openProjectCatalog } from './catalog.js';
import { openSnapshots,resolveSourceCommit } from './snapshots.js';
import { validateSourceReport,readCitation } from './citations.js';
import type { Citation,SourceReport } from '../../shared/projects.js';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const c of cleanup.splice(0))await c();});
async function setup(content='First\n<script>Literal</script>\nThird\n'){
 const f=await createProjectFixture();cleanup.push(f.dispose);await createRepository(f.root,'shop',{'source.ts':content});
 const root={projectsRoot:f.root,generation:'g1',revision:'r1',state:'ready' as const,message:null};
 const cat=await openProjectCatalog(f.local),p=(await cat.reconcile(root,await scanRoot(root,{timeoutMs:5000}))).records[0];
 const snapshots=await openSnapshots(f.local,{entries:100,totalBytes:1048576,fileBytes:524288,timeoutMs:5000}),resolved=await resolveSourceCommit(p,'main');await snapshots.importCommit(p,resolved);
 const snapshot=await snapshots.materialize(p,resolved),entry=(await snapshots.verify(snapshot)).entries[0];
 const citation:Citation={id:'source',repositoryId:p.id,commit:snapshot.commit,path:'source.ts',objectId:entry.objectId,contentDigest:entry.contentDigest!,startLine:2,endLine:2};
 const report:SourceReport={format:'source-report-v1',text:'Observed [cite:source].',citations:[citation]};
 return {...f,snapshots,snapshot,citation,report};
}
it('validates immutable file identity and returns literal bounded source lines',async()=>{
 const f=await setup();await validateSourceReport(f.report,[f.snapshot],f.snapshots,{textBytes:131072,citations:256});
 expect(await readCitation(f.report,'source',[f.snapshot],f.snapshots)).toMatchObject({firstLine:1,startLine:2,endLine:2,lines:['First','<script>Literal</script>','Third']});
});
it.each([{path:'../secret'},{repositoryId:'other'},{commit:'f'.repeat(40)},{objectId:'f'.repeat(40)},{contentDigest:'f'.repeat(64)},
 {startLine:0},{endLine:4},{endLine:1003},{startLine:2.5}])('rejects invalid or unavailable citation %j',async change=>{
 const f=await setup();f.report.citations=[{...f.citation,...change}];
 await expect(validateSourceReport(f.report,[f.snapshot],f.snapshots,{textBytes:131072,citations:256})).rejects.toThrow();
});
it('rejects unknown markers and citation IDs without accepting arbitrary paths',async()=>{
 const f=await setup();await expect(readCitation(f.report,'../../source.ts',[f.snapshot],f.snapshots)).rejects.toThrow();
 await expect(validateSourceReport({...f.report,text:'[cite:missing]'},[f.snapshot],f.snapshots,{textBytes:131072,citations:256})).rejects.toThrow();
 await expect(validateSourceReport({...f.report,citations:[f.citation,f.citation]},[f.snapshot],f.snapshots,{textBytes:131072,citations:256})).rejects.toThrow();
});
it('rejects source ranges too large to display and report text over its limit',async()=>{
 const f=await setup('First\n'+'x'.repeat(270000)+'\n');
 await expect(validateSourceReport(f.report,[f.snapshot],f.snapshots,{textBytes:131072,citations:256})).rejects.toThrow(/limit|large/);
 await expect(validateSourceReport(f.report,[f.snapshot],f.snapshots,{textBytes:3,citations:256})).rejects.toThrow(/limit/);
});
