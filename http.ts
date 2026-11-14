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
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/** Read a whole request body (git packs included). Null when it grows past a generous cap. */
export async function readBody(req: IncomingMessage, cap = 256 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > cap) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The token the trial assigned this entry, or '' when the environment named none. */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
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
