import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { CatalogSnapshot, DiscoveryResult, ProjectEdit, ProjectReadiness, ProjectRecord, RootSetting } from '../../shared/projects.js';
import { normalizeProjectName } from '../../shared/project-resolution.js';
import { BoundaryError } from '../../shared/validate.js';
import { confinedPath } from '../store/paths.js';
import { writeAtomic } from '../store/atomic.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const discoveredProjectId=(generation:string,path:string)=>`discovered-${hash([generation,path]).slice(0,32)}`;
export type ProjectCatalog={read():Promise<CatalogSnapshot>;reconcile(root:RootSetting,discovery:DiscoveryResult):Promise<CatalogSnapshot>;
 edit(input:ProjectEdit):Promise<ProjectRecord>;get(id:string):Promise<ProjectRecord>;
 setReadiness(id:string,readiness:ProjectReadiness,error:string|null):Promise<void>};
type State={view:CatalogSnapshot;history:Record<string,ProjectRecord>;requests:Record<string,{digest:string;result:ProjectRecord}>};
const recordRevision=(record:ProjectRecord)=>{const {revision,lastScannedAt,...rest}=record;return hash(rest);};
export async function openProjectCatalog(localRoot:string):Promise<ProjectCatalog>{
 const dir=await confinedPath(localRoot,'projects/catalog');await mkdir(dir,{recursive:true});
 const path=await confinedPath(localRoot,'projects/catalog/state.json');let queue:Promise<unknown>=Promise.resolve();
 const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.catch(()=>{}).then(fn);queue=next;return next;};
 async function load():Promise<State>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  return {view:{generation:'unset',revision:'unset',state:'unset',projects:[],records:[],ineligible:[],scannedAt:''},history:{},requests:{}};}}
 async function save(state:State){
  const v=state.view;v.projects=v.records.map(p=>({id:p.id,name:p.name,aliases:p.aliases}));
  v.revision=hash([v.generation,v.state,v.records.map(p=>[p.id,p.revision])]);
  for(const p of v.records)state.history[p.id]=p;
  await writeAtomic(path,`${JSON.stringify(state)}\n`);
 }
 return {
  read:()=>serial(async()=>(await load()).view),
  get:id=>serial(async()=>{const state=await load();if(!Object.hasOwn(state.history,id))throw new BoundaryError('missing','Project is unavailable');return state.history[id];}),
  reconcile:(root,discovery)=>serial(async()=>{
   const state=await load(),prior=state.view;
   const records:ProjectRecord[]=[];
   for(const entry of discovery.entries){
    if(!entry.canonicalPath||!entry.gitDir)continue;
    const id=discoveredProjectId(root.generation,entry.canonicalPath),old=state.history[id];
    const record:ProjectRecord={id,repositoryId:id,generation:root.generation,name:entry.name,aliases:old?.aliases??[],
     sourcePath:entry.canonicalPath,gitDir:entry.gitDir,displayName:old?.displayName??entry.name,
     defaultRef:old?old.defaultRef:entry.currentBranch,branches:entry.branches,observedCommit:entry.observedCommit,
     revision:'',readiness:entry.error?'failed':old?.readiness??'discovered',error:entry.error??(old?.readiness==='failed'?old.error:null),lastScannedAt:discovery.scannedAt};
    record.revision=recordRevision(record);records.push(record);
   }
   if(root.generation===prior.generation)for(const old of prior.records)if(!records.some(p=>p.id===old.id)){
    const missing={...old,readiness:'failed' as const,error:root.state==='unavailable'?'Projects root is unavailable':'Repository is missing or ineligible',lastScannedAt:discovery.scannedAt};
    missing.revision=recordRevision(missing);records.push(missing);
   }
   state.view={generation:root.generation,revision:'',state:root.state,projects:[],records:root.state==='unset'?[]:records,
    ineligible:discovery.entries.filter(e=>!e.canonicalPath),scannedAt:discovery.scannedAt};
   await save(state);return state.view;
  }),
  edit:input=>serial(async()=>{
   const state=await load(),digest=hash(input),prior=Object.hasOwn(state.requests,input.requestId)?state.requests[input.requestId]:undefined;
   if(prior){if(prior.digest!==digest)throw new BoundaryError('conflict','Request ID reused');return prior.result;}
   const p=state.view.records.find(p=>p.id===input.projectId);if(!p)throw new BoundaryError('missing','Project is unavailable');
   if(p.revision!==input.expectedRevision)throw new BoundaryError('conflict','Project changed; reload before saving');
   if(!Array.isArray(input.aliases)||input.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>250)||new Set(input.aliases.map(normalizeProjectName)).size!==input.aliases.length||!input.displayName?.trim())throw new BoundaryError('invalid','Invalid project name or aliases');
   const others=new Set(state.view.records.filter(other=>other.id!==p.id).flatMap(other=>[other.name,...other.aliases]).map(normalizeProjectName));
   if(input.aliases.some(alias=>others.has(normalizeProjectName(alias))))throw new BoundaryError('conflict','Alias matches another project name');
   if(input.defaultRef!==null&&!p.branches.includes(input.defaultRef))throw new BoundaryError('invalid','Select an available branch');
   Object.assign(p,{aliases:input.aliases.map(a=>a.trim()),displayName:input.displayName.trim(),defaultRef:input.defaultRef});p.revision=recordRevision(p);
   state.requests[input.requestId]={digest,result:structuredClone(p)};await save(state);return p;
  }),
  setReadiness:(id,readiness,error)=>serial(async()=>{const state=await load(),p=state.view.records.find(p=>p.id===id);if(!p)throw new BoundaryError('missing','Project is unavailable');
   p.readiness=readiness;p.error=error;p.revision=recordRevision(p);await save(state);}),
 };
}
