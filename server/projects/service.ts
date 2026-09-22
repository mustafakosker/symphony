import { createHash } from 'node:crypto';import { mkdir,readFile } from 'node:fs/promises';
import type { DraftText,ResolutionChoices,OperationStatus,ProjectRecord,SnapshotRef } from '../../shared/projects.js';import { BoundaryError } from '../../shared/validate.js';
import type { Settings } from '../config/settings.js';import type { Registry } from '../config/registry.js';import { openStore,type Store } from '../store/task-store.js';import { writeAtomic } from '../store/atomic.js';import { confinedPath } from '../store/paths.js';
import { openProjectSettings } from './settings.js';import { openProjectCatalog } from './catalog.js';import { scanRoot } from './discovery.js';import { openSnapshots,resolveSourceCommit } from './snapshots.js';import { openBriefs } from './briefs.js';import { createBriefJobs,createBriefTask } from './brief-jobs.js';import { createStoreRouter } from '../coordinator/store-router.js';import { createProjectBinding,previewResolution } from './binding.js';import { createProjectDrafts } from '../intake/project-drafts.js';import { snapshotLimits,resolveSnapshotAccess } from '../codex/snapshot-access.js';import { verifySnapshotProfile } from '../codex/snapshot-capability.js';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
type Operation={status:OperationStatus;digest:string;project?:ProjectRecord;ref?:string;resolved?:{commit:string;objectFormat:'sha1'|'sha256'};snapshot?:SnapshotRef;jobId?:string;generate?:boolean};
type Options={registry?:Registry;runtimeVersion?:string;verifyAccess?:(project:ProjectRecord,snapshot:SnapshotRef)=>Promise<void>};
export type ProjectServices=Awaited<ReturnType<typeof openProjectServices>>;
export async function openProjectServices(configPath:string,host:Settings,primary:Store,options:Options={}){
 const settings=await openProjectSettings(configPath,host),catalog=await openProjectCatalog(host.localRoot),snapshots=await openSnapshots(host.localRoot,snapshotLimits(host)),briefs=await openBriefs(host.localRoot,snapshots);
 const jobs=await openStore(await confinedPath(host.localRoot,'projects/job-store')),schedulerStore=createStoreRouter(primary,jobs),briefJobs=createBriefJobs({store:jobs,briefs,snapshots,localRoot:host.localRoot});
 const binding=await createProjectBinding({catalog,snapshots,briefs,localRoot:host.localRoot});
 const resolve=async(text:DraftText,choices:ResolutionChoices)=>{const root=await settings.read(),view=await catalog.read();return previewResolution(text,{...view,generation:root.generation,state:root.state,...(root.generation!==view.generation?{projects:[]}: {})},choices);};
 const draftGate=await createProjectDrafts({binding,localRoot:host.localRoot,resolve,defaults:async preview=>{const selections=[];for(const id of [...(preview.targetId?[preview.targetId]:[]),...preview.referenceIds]){const p=await catalog.get(id),brief=await briefs.current(id);if(p.readiness!=='ready'||!p.defaultRef||!brief)return null;selections.push({projectId:id,ref:p.defaultRef,briefVersion:brief.version});}return selections;}});
 const dir=await confinedPath(host.localRoot,'projects/operations');await mkdir(dir,{recursive:true});const path=await confinedPath(dir,'state.json');let queue:Promise<unknown>=Promise.resolve(),background:Promise<void>|null=null;
 type State={operations:Record<string,Operation>};const load=async():Promise<State>=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {operations:{}};throw e;}};
 const save=(s:State)=>writeAtomic(path,JSON.stringify(s));const serial=<T>(f:()=>Promise<T>)=>{const p=queue.catch(()=>{}).then(f);queue=p;return p;};
 const verifyAccess=options.verifyAccess??(async(project:ProjectRecord,snapshot:SnapshotRef)=>{const role=options.registry?.roles.find(r=>r.role==='researcher');if(!role||!options.runtimeVersion)throw new Error('Needs setup: install and verify a read-only researcher profile for this snapshot scope');
  const task=createBriefTask(project,snapshot),step=task.workflow!.steps[0];if(step.kind!=='agent')throw new Error('Invalid brief workflow');
  await verifySnapshotProfile(host,{task,step,role,snapshotAccess:await resolveSnapshotAccess(task.projectContext,step.repositories,snapshots)},options.runtimeVersion);
 });
 async function enqueue(kind:OperationStatus['kind'],projectId:string|null,ref:string|undefined,requestId:string,generate=false){return serial(async()=>{
  if(!requestId)throw new BoundaryError('invalid','Request ID required');const state=await load(),id=hash(requestId),digest=hash([kind,projectId,ref,generate]),prior=state.operations[id];if(prior){if(prior.digest!==digest)throw new BoundaryError('conflict','Operation request differs');return prior.status;}
  const root=await settings.read();if(kind!=='scan'&&root.state!=='ready')throw new BoundaryError('unavailable','Projects root is unavailable');
  const project=projectId?await catalog.get(projectId):undefined;if(project&&(project.generation!==root.generation||!ref||!project.branches.includes(ref)))throw new BoundaryError('invalid','Select an available project branch');
  const op:Operation={status:{id,revision:1,kind,state:'queued',message:'Queued',taskId:null},digest,project,ref,generate};state.operations[id]=op;await save(state);return op.status;
 });}
 async function work(){await serial(async()=>{const state=await load();for(const op of Object.values(state.operations)){
  if(['complete','failed','needs-input'].includes(op.status.state))continue;
  try{if(op.status.kind==='scan'){const root=await settings.read();let discovery={entries:[],scannedAt:new Date().toISOString()} as Awaited<ReturnType<typeof scanRoot>>;
    if(root.state==='ready')discovery=await scanRoot(root,{timeoutMs:host.projectGitTimeoutMs});await catalog.reconcile(root,discovery);op.status.state='complete';op.status.message=root.state==='unavailable'?'Projects root unavailable':'Project scan complete';
   }else if(op.project&&op.ref){const p=op.project;
    if(!op.resolved){op.resolved=await resolveSourceCommit(p,op.ref);op.status.state='running';op.status.message='Commit pinned';}
    else if(!op.snapshot){await snapshots.importCommit(p,op.resolved);op.snapshot=await snapshots.materialize(p,op.resolved);op.status.message='Snapshot prepared';}
    else if(!op.jobId){try{await verifyAccess(p,op.snapshot);}catch(e){await catalog.setReadiness(p.id,'needs-setup',String(e));op.status.state='needs-input';op.status.message=String(e);op.status.revision++;await save(state);continue;}
     if(op.generate||!await briefs.current(p.id)){const job=await briefJobs.enqueue(p,op.snapshot,`prepare:${op.status.id}`);op.jobId=job.id;op.status.message='Generating project brief';await catalog.setReadiness(p.id,'preparing',null);}
     else{await catalog.setReadiness(p.id,'ready',null);op.status.state='complete';op.status.message='Project ready';}
    }else{const job=await briefJobs.status(op.jobId);op.status.state=job.state;op.status.message=job.message;if(job.state==='complete')await catalog.setReadiness(p.id,'ready',null);if(job.state==='failed')await catalog.setReadiness(p.id,'failed',job.message);}
   }
  }catch(e){op.status.state='failed';op.status.message=e instanceof Error?e.message:'Project operation failed';if(op.project)await catalog.setReadiness(op.project.id,'failed',op.status.message).catch(()=>{});}
  op.status.revision++;await save(state);
 }});await briefJobs.reconcile();await binding.tick();}
 const api={settings,catalog,snapshots,briefs,briefJobs,binding,draftGate,schedulerStore,primary,resolve,
  rescan:(requestId:string)=>enqueue('scan',null,undefined,requestId),prepare:(id:string,ref:string,requestId:string)=>enqueue('prepare',id,ref,requestId),
  generate:(id:string,ref:string,requestId:string)=>enqueue('brief',id,ref,requestId,true),verify:async(id:string,requestId:string)=>enqueue('verify',id,(await catalog.get(id)).defaultRef??undefined,requestId),
  operation:(id:string)=>serial(async()=>{const op=(await load()).operations[id];if(!op)return binding.status(id);return {...op.status,...(op.jobId?{candidate:await briefJobs.candidate(op.jobId),source:await briefJobs.source(op.jobId)}:{}),...(op.snapshot?{snapshot:op.snapshot}:{})};}),
  async tick(){if(!background)background=work().catch(e=>{lastError=e instanceof Error?e.message:String(e);}).finally(()=>{background=null;});},
  async close(){await background;await queue;},issues:()=>lastError?[{id:'project-services',taskId:null,message:lastError}]:[],
 };
 let lastError:string|null=null;
 // Catalog startup remains useful even when the configured source root is unavailable.
 const root=await settings.read(),view=await catalog.read();if(root.generation!==view.generation||root.state!==view.state)await api.rescan(`startup:${root.generation}:${root.state}:${Date.now()}`);
 return api;
}
