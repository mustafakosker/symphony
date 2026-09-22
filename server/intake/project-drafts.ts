import { createHash } from 'node:crypto';import { mkdir,readFile } from 'node:fs/promises';
import type { DraftText,ResolutionChoices,ResolutionPreview,ProjectDraft,ProjectContext,OperationStatus,ProjectSelection } from '../../shared/projects.js';import { deriveDraftText } from '../../shared/project-resolution.js';import { BoundaryError } from '../../shared/validate.js';import { confinedPath } from '../store/paths.js';import { writeAtomic } from '../store/atomic.js';import type { BindingService } from '../projects/binding.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export type PendingSubmission={submissionId:string;revision:number;filename:string;markdown:string;message:string;preview:ResolutionPreview;draft:ProjectDraft|null;operationId:string|null;ready:boolean};
type Prepare={submissionId:string;requestId:string;filename:string;markdown:string;projectDraft?:ProjectDraft};
type Prepared={state:'pending'|'needs-input';message:string}|{state:'ready';title:string;markdown:string;context:ProjectContext|null};
export type ProjectDraftGate={prepare(input:Prepare):Promise<Prepared>;resolveIssue(id:string,revision:number,input:ProjectDraft,requestId:string):Promise<OperationStatus>;list():Promise<PendingSubmission[]>};
export const draftMarkdown=(text:DraftText)=>text.title.trim()?`# ${text.title.trim()}\n\n${text.description.trim()}`:text.description.trim();
export async function createProjectDrafts(deps:{binding:BindingService;localRoot:string;resolve:(draft:DraftText,choices:ResolutionChoices)=>Promise<ResolutionPreview>; defaults?:(preview:ResolutionPreview)=>Promise<ProjectSelection[]|null>}):Promise<ProjectDraftGate>{
 const dir=await confinedPath(deps.localRoot,'projects/submissions');await mkdir(dir,{recursive:true});const path=await confinedPath(dir,'state.json');let queue:Promise<unknown>=Promise.resolve();
 type State={items:PendingSubmission[];requests:Record<string,{digest:string;status:OperationStatus}>};
 const load=async():Promise<State>=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {items:[],requests:{}};throw e;}};
 const save=(s:State)=>writeAtomic(path,JSON.stringify(s));const serial=<T>(f:()=>Promise<T>)=>{const p=queue.catch(()=>{}).then(f);queue=p;return p;};
 async function accept(item:PendingSubmission,input:ProjectDraft,requestId:string){const preview=await deps.resolve(input.text,input.choices);
  if(preview.revision!==input.previewRevision||preview.catalogRevision!==input.catalogRevision)throw new BoundaryError('conflict','Project matches changed; review the draft again');
  if(preview.problems.length)throw new BoundaryError('invalid',preview.problems[0].message);
  item.preview=preview;item.draft=input;item.markdown=draftMarkdown(input.text);item.message='Preparing project context';
  if(preview.targetId||preview.referenceIds.length){const op=await deps.binding.begin(input,requestId);item.operationId=op.id;return op;}
  item.ready=true;return {id:item.submissionId,revision:item.revision,kind:'submission' as const,state:'complete' as const,message:'Draft ready',taskId:null};
 }
 return {prepare:input=>serial(async()=>{
   if(input.projectDraft&&draftMarkdown(input.projectDraft.text)!==input.markdown)throw new BoundaryError('invalid','Draft text does not match submitted Markdown');
   const state=await load();let item=state.items.find(i=>i.filename===input.filename);
   if(!item){const text=input.projectDraft?.text??deriveDraftText(input.markdown,input.filename),choices=input.projectDraft?.choices??{excludedReferenceIds:[],ambiguities:{}};
    const preview=await deps.resolve(text,choices);item={submissionId:input.submissionId,revision:1,filename:input.filename,markdown:input.markdown,message:preview.problems[0]?.message??'Review matched projects and select saved briefs',preview,draft:null,operationId:null,ready:false};
    if(input.projectDraft)await accept(item,input.projectDraft,input.requestId);
    else if(!preview.problems.length&&!preview.targetId&&!preview.referenceIds.length)item.ready=true;
    else if(!preview.problems.length&&deps.defaults){const selections=await deps.defaults(preview);if(selections)await accept(item,{text,choices,previewRevision:preview.revision,catalogRevision:preview.catalogRevision,selections},input.requestId);}
    state.items.push(item);await save(state);
   }
   if(item.operationId){const status=await deps.binding.status(item.operationId);if(status.state==='complete'){item.ready=true;await save(state);}else return {state:status.state==='failed'?'needs-input':'pending',message:status.message};}
   if(!item.ready)return {state:'needs-input',message:item.message};
   return {state:'ready',title:item.preview.generation==='unset'?item.filename.slice(0,-3):item.draft?.text.title??deriveDraftText(item.markdown,item.filename).title,markdown:item.markdown,context:item.operationId?await deps.binding.getContext(item.operationId):null};
  }),resolveIssue:(id,revision,input,requestId)=>serial(async()=>{const state=await load(),key=hash(requestId),digest=hash([id,revision,input]);const prior=state.requests[key];if(prior){if(prior.digest!==digest)throw new BoundaryError('conflict','Resolution request differs');return prior.status;}
   const item=state.items.find(i=>i.submissionId===id);if(!item)throw new BoundaryError('missing','Pending submission is unavailable');
   if(item.revision!==revision||item.operationId||item.ready)throw new BoundaryError('conflict','Submission was already accepted or changed');
   const status=await accept(item,input,`resolution:${id}:${requestId}`);item.revision++;state.requests[key]={digest,status};await save(state);return status;
  }),list:()=>serial(async()=>(await load()).items.filter(i=>!i.ready)),
 };
}
