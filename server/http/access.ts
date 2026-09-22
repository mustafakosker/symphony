import type { IncomingMessage } from 'node:http';
import { BoundaryError } from '../../shared/validate.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function checkAccess(request: IncomingMessage, allowedOrigin: string, mutation: boolean): void {
  const origin = request.headers.origin;
  if (origin && origin !== allowedOrigin) throw new HttpError(403, 'Origin is not allowed');
  if (mutation && origin !== allowedOrigin) throw new HttpError(403, 'Origin is required');
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') throw new HttpError(403, 'Cross-origin request is not allowed');
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(400, 'JSON content type is required');
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new HttpError(413, 'Request body is too large');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new BoundaryError('invalid', 'Malformed JSON request');
  }
}
