import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { OnaAdapter, OnaLaunch, OnaOutcome } from './adapter.js';
import { parseFrozenPackage, parseOnaReceipt } from '../../shared/jira-validation.js';
import { bytesDigest, digest } from '../preparation/operations.js';
import { validateDocument } from '../preparation/documents.js';
import { confinedPath } from '../store/paths.js';
import { writeAtomic } from '../store/atomic.js';
type Entry = { requestId:string;payloadDigest:string;outcome:OnaOutcome };
export function createMockOnaAdapter({localRoot,scenario='accept'}:{localRoot:string;scenario?:'accept'|'reject'|'accept-then-timeout'}):OnaAdapter {
 let queue=Promise.resolve();
 const path=(id:string)=>confinedPath(localRoot,`jira-handoff/ona/${bytesDigest(Buffer.from(id))}.json`);
 async function read(id:string):Promise<Entry|null> {
  try {
   const entry=JSON.parse(await readFile(await path(id),'utf8')) as Entry;
   if(entry.requestId!==id || !/^[a-f0-9]{64}$/.test(entry.payloadDigest)) throw new Error('Invalid ledger');
   if(entry.outcome.kind==='accepted') { const receipt=parseOnaReceipt(entry.outcome.receipt); if(receipt.requestId!==id || !receipt.simulated) throw new Error('Invalid receipt'); }
   else if(entry.outcome.kind!=='not-accepted' || typeof entry.outcome.reason!=='string') throw new Error('Invalid outcome');
   return entry;
  } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
 }
 function verify(input:OnaLaunch) {
  const p=parseFrozenPackage(input.package);
  if(!input.promptText.trim() || bytesDigest(Buffer.from(input.promptText))!==p.prompt.ref.digest) throw new Error('Invalid prompt bytes');
  if(input.documents.length!==2) throw new Error('Both documents are required');
  for(const role of ['design','implementation'] as const) {
   const matches=input.documents.filter(d=>d.role===role), selected=p.documents[role];
   if(matches.length!==1) throw new Error('Document roles must be unique');
   const d=matches[0]; validateDocument(d.filename,d.bytes);
   if(d.filename!==selected.filename || d.bytes.length!==selected.size || bytesDigest(d.bytes)!==selected.ref.digest) throw new Error('Document differs from manifest');
  }
  return digest(p);
 }
 return {
  async launch(input,signal) {
   const payloadDigest=verify(input), id=input.package.requestId;
   const work=queue.then(async()=>{
    signal.throwIfAborted();
    const prior=await read(id);
    if(prior && prior.payloadDigest!==payloadDigest) throw new Error('Request key has different content');
    if(prior?.outcome.kind==='accepted') return prior.outcome;
    const outcome:OnaOutcome=scenario==='reject'?{kind:'not-accepted',reason:'Mock ONA rejected this launch'}:
     {kind:'accepted',receipt:{requestId:id,receiptId:`mock-${randomUUID()}`,acceptedAt:new Date().toISOString(),simulated:true}};
    await mkdir(await confinedPath(localRoot,'jira-handoff/ona'),{recursive:true});
    await writeAtomic(await path(id),JSON.stringify({requestId:id,payloadDigest,outcome})); return outcome;
   });
   queue=work.then(()=>undefined,()=>undefined);
   const outcome=await work;
   if(scenario==='accept-then-timeout' && outcome.kind==='accepted') await new Promise<void>((_,reject)=>{
    if(signal.aborted) {reject(signal.reason);return;} signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   });
   return outcome;
  },
  async lookup(id,signal) {
   signal.throwIfAborted(); await queue;
   try {return (await read(id))?.outcome ?? {kind:'not-accepted',reason:'No launch recorded by mock ONA'};}
   catch {return {kind:'unknown',reason:'Mock ONA receipt could not be read'};}
  },
 };
}
