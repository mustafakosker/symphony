import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/task-store';
import { jiraTask } from './testing';
import { createPreparationOperations } from './operations';
import { createDocumentService } from './documents';
import { createDraftService } from './drafts';
import { createHandoffService } from './handoff';
import { createMockOnaAdapter } from '../ona/mock';
import type { PreparationAction } from '../../shared/jira-preparation';
const registry = { roles: [], projects: [{ id: 'app', names: ['App'], repositories: [{ id: 'web', localPath: null, mcpProfile: 'mock', baseRef: 'main', defaultRef: 'main' }] }] };
let root: string, store: Store;
const design = Buffer.from('\uFEFF# Café\r\n'), implementation = Buffer.from('Implementation\n'), promptText = ' Exact launch\r\n';
beforeEach(async () => {
 root = await mkdtemp(join(tmpdir(), 'jira-handoff-')); store = await openStore(join(root,'workspace')); await store.create(jiraTask(), 'create');
 const ops = createPreparationOperations(store), docs = createDocumentService(store, ops), drafts = createDraftService(store, registry, ops);
 let task = await store.get(jiraTask().id);
 for (const [role,bytes] of [['design',design],['implementation',implementation]] as const)
  task = await docs.upload({ taskId:task.id, requestId:role, expectedRevision:task.revision, role, filename:role+'.md' }, bytes);
 await drafts.save({taskId:task.id, requestId:'save',expectedRevision:task.revision,action:{kind:'save',promptText,target:{projectId:'app',repositoryId:'web',branch:'main'}}});
});
afterEach(async () => { await rm(root,{recursive:true,force:true}); });
async function command(action: PreparationAction = {kind:'send'}, requestId='send') { return {taskId:jiraTask().id,requestId,expectedRevision:(await store.get(jiraTask().id)).revision,action}; }
function service(adapter = createMockOnaAdapter({localRoot:root})) { return createHandoffService({store,registry,operations:createPreparationOperations(store),adapter,timeoutMs:20}); }
it('persists intent before launch and freezes exact bytes; duplicate send does not launch twice', async () => {
 const mock = createMockOnaAdapter({localRoot:root});
 const launch = vi.fn(async (input, signal) => {
  expect((await store.get(input.package.taskId)).preparation!.attempts.at(-1)!.status).toBe('sending');
  expect(input.promptText).toBe(promptText); expect(input.documents.map((d: {bytes:Uint8Array})=>d.bytes)).toEqual([design,implementation]);
  expect(input.package.jira.key).toBe('APP-1'); expect(input.package.target.branch).toBe('main');
  return mock.launch(input,signal);
 });
 const handoff=service({...mock,launch}), send=await command(); const task=await handoff.send(send);
 expect(task.status).toBe('done'); expect((await handoff.send(send)).revision).toBe(task.revision); expect(launch).toHaveBeenCalledTimes(1);
 store=await openStore(join(root,'workspace'));
 const frozen=JSON.parse(Buffer.from(await store.readArtifact(task.id,task.preparation!.attempts[0].packageRef)).toString());
 expect(frozen.documents.design.ref).toEqual(task.preparation!.documents.design!.ref);
});
it('recovers acceptance after timeout by lookup only', async () => {
 const handoff=service(createMockOnaAdapter({localRoot:root,scenario:'accept-then-timeout'}));
 const task=await handoff.send(await command()); expect(task.preparation!.attempts[0].status).toBe('unconfirmed');
 store=await openStore(join(root,'workspace')); const mock=createMockOnaAdapter({localRoot:root}), launch=vi.fn(mock.launch);
 await service({...mock,launch}).recover();
 const recovered=await store.get(task.id); expect(recovered.status).toBe('done');
 expect(recovered.preparation!.attempts[0].receipt!.requestId).toBe(task.preparation!.attempts[0].requestId); expect(launch).not.toHaveBeenCalled();
});
it('retries only an unchanged definitively rejected package and binds duplicate retry', async () => {
 const first=await service(createMockOnaAdapter({localRoot:root,scenario:'reject'})).send(await command());
 const request=first.preparation!.attempts[0].requestId;
 const retry=await command({kind:'retry',handoffRequestId:request},'retry');
 const handoff=service(); const accepted=await handoff.retry(retry); expect(accepted.status).toBe('done');
 expect(accepted.preparation!.attempts[0].dispatch).toBe(2); expect((await handoff.retry(retry)).revision).toBe(accepted.revision);
});
it('requires a new send after editing a rejected package', async () => {
 const handoff=service(createMockOnaAdapter({localRoot:root,scenario:'reject'})); const task=await handoff.send(await command());
 await createDraftService(store,registry,createPreparationOperations(store)).save(await command({kind:'save',promptText:'Changed',target:task.preparation!.target},'edit'));
 await expect(handoff.retry(await command({kind:'retry',handoffRequestId:task.preparation!.attempts[0].requestId},'retry'))).rejects.toThrow(/changed/i);
 expect((await service().send(await command({kind:'send'},'new-send'))).preparation!.attempts).toHaveLength(2);
});
it('verifies artifacts before launching and aborts in-flight calls on close', async () => {
 const mock=createMockOnaAdapter({localRoot:root}), launch=vi.fn(mock.launch), handoff=service({...mock,launch});
 const read=store.readArtifact.bind(store); store.readArtifact=async()=>{throw new Error('Corrupt bytes');};
 await expect(handoff.send(await command())).rejects.toThrow('Corrupt bytes'); expect(launch).not.toHaveBeenCalled(); store.readArtifact=read;
 const slow=service(createMockOnaAdapter({localRoot:root,scenario:'accept-then-timeout'}));
 const sent=slow.send(await command()); await vi.waitFor(async()=>expect((await store.get(jiraTask().id)).status).toBe('running'));
 await slow.close(); expect((await sent).preparation!.attempts[0].status).toBe('unconfirmed');
 await expect(slow.send(await command({kind:'send'},'later'))).rejects.toThrow();
});
it('allows Jira refresh during network wait and rejects stale dispatch outcomes', async () => {
 let release!:()=>void; const gate=new Promise<void>(r=>{release=r;}); const mock=createMockOnaAdapter({localRoot:root});
 const handoff=createHandoffService({store,registry,operations:createPreparationOperations(store),adapter:{...mock,launch:async(i,s)=>{await gate;return mock.launch(i,s);}}});
 const sent=handoff.send(await command()); await vi.waitFor(async()=>expect((await store.get(jiraTask().id)).status).toBe('running'));
 let task=await store.get(jiraTask().id); const attempt=task.preparation!.attempts[0];
 task=await store.apply(task.id,task.revision,'refresh',{kind:'preparation',inputDigest:'b'.repeat(64),change:{kind:'source',source:{...task.preparation!.source,title:'New title'},digest:'b'.repeat(64),matchesQuery:true}});
 await expect(store.apply(task.id,task.revision,'stale',{kind:'preparation',inputDigest:'c'.repeat(64),change:{kind:'settle',handoffRequestId:attempt.requestId,dispatch:2,outcome:'unconfirmed',receipt:null,reason:'stale'}})).rejects.toThrow();
 release(); expect((await sent).title).toBe('New title');
});
