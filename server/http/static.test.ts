import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from './static.js';

let root: string; let server: Server; let base: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'symphony-static-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<h1>UI</h1>');
  await writeFile(join(root, 'assets/app.js'), 'window.app=true');
  server = createServer(createStaticHandler(root));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

it('serves only known build files with safe MIME types', async () => {
  expect(await (await fetch(base)).text()).toBe('<h1>UI</h1>');
  const script = await fetch(`${base}/assets/app.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toContain('javascript');
  expect((await fetch(`${base}/server/main.ts`)).status).toBe(404);
});

it('rejects symlinked assets and path traversal', async () => {
  await symlink(join(root, 'index.html'), join(root, 'assets/link.js'));
  expect((await fetch(`${base}/assets/link.js`)).status).toBe(404);
  const status = await new Promise<number>((resolve, reject) => {
    request(base, { path: '/assets/%2e%2e/index.html' }, response => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end();
  });
  expect(status).toBe(404);
});
