// Shared HTTP plumbing for the four surfaces: JSON replies that always carry the request-id
// header the protocol checks sample, request-body reading, and the bearer-token rule.
//
// Token rule: the trial hands the entry its token in MAKEFUN_SHOP_TOKEN (wire.ts TOKEN_ENV) and
// every suite client presents exactly that token. When the variable is set, only that token
// authenticates; when it is unset (a local run), any presented bearer token authenticates and
// only a missing one is refused — the property every check actually tests.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.sendDate = false;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(payload);
}

/** Send an already-serialized JSON body (the exact bytes JSON.stringify would have produced). */
export function sendJsonText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  const payload = Buffer.from(`${text}\n`, 'utf8');
  res.sendDate = false;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.sendDate = false;
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.sendDate = false;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/** Read a whole request body (git packs included). Null when it grows past a generous cap. */
export async function readBody(req: IncomingMessage, cap = 256 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > cap) {
        settled = true;
        cleanup();
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('request aborted'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** The token the trial assigned this entry, or '' when the environment named none. The
 *  environment is fixed before the process starts, so the first read is cached for the
 *  process's lifetime instead of being looked up on every request. */
let expectedTokenCache: string | null = null;

export function expectedToken(): string {
  if (expectedTokenCache === null) expectedTokenCache = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expectedTokenCache;
}

/** Whether the request carries a bearer token the forge accepts. */
export function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = match[1]!.trim();
  if (presented === '') return false;
  const expected = expectedToken();
  return expected === '' || presented === expected;
}

/** The request's origin (scheme + host) for absolute pagination links. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
