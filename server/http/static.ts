import { constants, readdirSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { join } from 'node:path';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function createStaticHandler(root: string): RequestListener {
  const known = new Set(['/index.html']);
  for (const name of readdirSync(join(root, 'assets'))) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && mime[name.slice(name.lastIndexOf('.'))]) known.add(`/assets/${name}`);
  }
  return (request, response) => {
    void (async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(404); response.end(); return; }
      const rawPath = (request.url ?? '').split('?')[0];
      const path = rawPath === '/' ? '/index.html' : rawPath;
      if (!known.has(path) || /%|\\|\.\./.test(rawPath)) { response.writeHead(404); response.end(); return; }
      const file = join(root, path.slice(1));
      const canonicalRoot = await realpath(root);
      const canonicalFile = await realpath(file);
      if (!canonicalFile.startsWith(canonicalRoot + '/')) { response.writeHead(404); response.end(); return; }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) { response.writeHead(404); response.end(); return; }
        const extension = path.slice(path.lastIndexOf('.'));
        response.writeHead(200, { 'Content-Type': mime[extension], 'Content-Length': info.size,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': path === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
          'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'" });
        if (request.method === 'HEAD') response.end();
        else response.end(await handle.readFile());
      } finally { await handle.close(); }
    })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); });
  };
}
