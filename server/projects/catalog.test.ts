import { afterEach, expect, it } from 'vitest';
import { createProjectFixture, createRepository } from '../testing/projects.js';
import { scanRoot } from './discovery.js';
import { openProjectCatalog } from './catalog.js';
import type { RootSetting } from '../../shared/projects.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
async function setup() { const f=await createProjectFixture(); cleanups.push(f.dispose);
 await createRepository(f.root,'shop',{ a:'A' }); await createRepository(f.root,'pay',{ a:'B' });
 const root:RootSetting={ projectsRoot:f.root,generation:'g1',revision:'r1',state:'ready',message:null };
 const catalog=await openProjectCatalog(f.local), scan=await scanRoot(root,{ timeoutMs:5000 });
 return { ...f,root,catalog,scan,view:await catalog.reconcile(root,scan) }; }
it('preserves identity, aliases and revision through unchanged scans and restart',async()=>{
 const f=await setup(), project=f.view.records.find(p=>p.name==='shop')!;
 const edited=await f.catalog.edit({projectId:project.id,expectedRevision:project.revision,requestId:'edit',aliases:['Storefront'],displayName:'Store',defaultRef:'main'});
 const rescanned=await f.catalog.reconcile(f.root,{...f.scan,scannedAt:'later'});
 expect(rescanned.records.find(p=>p.id===project.id)).toMatchObject({aliases:['Storefront'],displayName:'Store',revision:edited.revision});
 expect((await f.catalog.reconcile(f.root,{...f.scan,scannedAt:'later again'})).revision).toBe(rescanned.revision);
 expect((await (await openProjectCatalog(f.local)).read()).revision).toBe(rescanned.revision);
});
it('rejects alias collisions and stale concurrent edits',async()=>{
 const f=await setup(), project=f.view.records[0];
 await expect(f.catalog.edit({projectId:project.id,expectedRevision:project.revision,requestId:'collision',aliases:[f.view.records[1].name],displayName:project.name,defaultRef:'main'})).rejects.toThrow(/alias|name/i);
 const input={projectId:project.id,expectedRevision:project.revision,requestId:'edit',aliases:['Alias'],displayName:project.name,defaultRef:'main'};
 await f.catalog.edit(input); await expect(f.catalog.edit({...input,requestId:'stale',aliases:['Other']})).rejects.toMatchObject({code:'conflict'});
});
it('retires old identities when the configured root generation changes',async()=>{
 const f=await setup(); const newer=await f.catalog.reconcile({...f.root,generation:'g2'},f.scan);
 expect(newer.records.map(p=>p.id).some(id=>f.view.records.some(p=>p.id===id))).toBe(false);
 expect(newer.projects.map(p=>p.name)).toEqual(['pay','shop']);
});
