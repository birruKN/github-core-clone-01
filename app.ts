// The HTTP surface: one server routing the four surfaces the suite drives — git smart HTTP at
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp — plus
// the env's /healthz boot probe and a JSON 404 for everything else. app.ts is the server;
// main.ts (the env lifecycle) stays as the starter shipped it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { readBody, sendJson } from './http.ts';

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  // Split the request target by hand: the WHATWG parser's only services here are the
  // pathname/searchParams split, and URLSearchParams parses the query identically. Targets
  // that are not canonical absolute paths (dot segments, backslashes, fragments, authority
  // forms) still go through the real parser, whose normalization they may rely on.
  const rawTarget = req.url ?? '/';
  const queryIndex = rawTarget.indexOf('?');
  let path = queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  let searchParams = new URLSearchParams(queryIndex < 0 ? '' : rawTarget.slice(queryIndex + 1));
  if (
    !rawTarget.startsWith('/') ||
    rawTarget.startsWith('//') ||
    path.includes('/.') ||
    path.includes('\\') ||
    path.includes('#')
  ) {
    const url = new URL(rawTarget, 'http://entry');
    path = url.pathname;
    searchParams = url.searchParams;
  }

  // The env's boot check calls this twice: 200 {"ok":true}. No auth, by design.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? ((await readBody(req)) ?? Buffer.alloc(0)) : Buffer.alloc(0);

  if (path === '/mcp') {
    handleMcp(forge, req, res, body);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    handleGraphQL(forge, req, res, body);
    return;
  }

  // Decoded segments are only needed to route the REST surface, and only /api targets can
  // reach it; git and the fixed paths above never pay for the split. Decoding is the
  // identity for segments without a '%', so the call is skipped for those.
  const segments = path.startsWith('/api')
    ? path
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => (segment.includes('%') ? decode(segment) : segment))
    : null;

  if (segments !== null && segments[0] === 'api' && segments[1] === 'v3') {
    let json: Record<string, unknown> = {};
    if (body.length > 0) {
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    handleRest(forge, req, res, segments.slice(2), searchParams, json);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    handleGit(forge, req, res, decode(gitMatch[1]!), decode(gitMatch[2]!), gitMatch[3]!, searchParams, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(forge, req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] a request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      else res.end();
    });
  });
}
