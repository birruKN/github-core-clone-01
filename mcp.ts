// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the modern
// 2026-07-28 revision — `server/discover` answers identity, capabilities and supported
// versions in one request, no handshake or session needed (the legacy `initialize` handshake
// is answered too, for clients that ask). The six tools act on the same store as REST, so an
// object created here reads back over /api/v3 with the same id.
//
// Wire rules: no Authorization is 401; a body that is not JSON is HTTP 400 with -32700; an
// unknown tool is -32602, never HTTP 500; a tools/call missing a required argument is -32602;
// every answer carries the request's own JSON-RPC id; tools/list is one static array, so two
// calls answer byte-for-byte identical lists.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Forge, type Repo } from './store.ts';
import { createIssueRecord, createPullRecord, issueView, pullView, repoView } from './rest.ts';
import { squashMerge } from './store.ts';
import { authorized, sendJson } from './http.ts';

const SERVER_INFO = { name: 'amber-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => { content: unknown; structured: unknown } | { error: string };
}

function textResult(structured: unknown): { content: unknown; structured: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured };
}

function required(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) return name;
  }
  return null;
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repo | { error: string } {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = forge.getRepo(owner, name);
  return repo ?? { error: `repository ${owner}/${name} not found` };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const missing = required(args, 'name');
      if (missing !== null) return { error: `missing required argument: ${missing}` };
      const repo = forge.createRepo(VIEWER.login, String(args.name), {
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return { error: `a repository named ${String(args.name)} already exists` };
      return textResult(repoView(repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const missing = required(args, 'owner', 'repo');
      if (missing !== null) return { error: `missing required argument: ${missing}` };
      const repo = repoOf(forge, args);
      if ('error' in repo) return repo;
      return textResult(repoView(repo));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const missing = required(args, 'owner', 'repo', 'title');
      if (missing !== null) return { error: `missing required argument: ${missing}` };
      const repo = repoOf(forge, args);
      if ('error' in repo) return repo;
      const issue = createIssueRecord(forge, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return textResult(issueView(repo, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const missing = required(args, 'owner', 'repo');
      if (missing !== null) return { error: `missing required argument: ${missing}` };
      const repo = repoOf(forge, args);
      if ('error' in repo) return repo;
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((issue) => issueView(repo, issue));
      return textResult(issues);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const missing = required(args, 'owner', 'repo', 'title', 'head', 'base');
      if (missing !== null) return { error: `missing required argument: ${missing}` };
      const repo = repoOf(forge, args);
      if ('error' in repo) return repo;
      const created = createPullRecord(forge, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: String(args.head).replace(/^refs\/heads\//, ''),
        baseRef: String(args.base).replace(/^refs\/heads\//, ''),
      });
      if ('error' in created) return { error: created.error };
      return textResult(pullView(repo, created));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const missing = required(args, 'owner', 'repo', 'pull_number');
      if (missing !== null) return { error: `missing required argument: ${missing}` };
      const repo = repoOf(forge, args);
      if ('error' in repo) return repo;
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { error: `pull request #${String(args.pull_number)} not found` };
      if (!pull.merged) {
        const outcome = squashMerge(forge, repo, pull);
        if (outcome.status === 'conflict') return { error: 'the pull request is not mergeable (conflict)' };
        if (outcome.status === 'missing') return { error: 'a branch is missing' };
      }
      return textResult(pullView(repo, pull));
    },
  },
];

/** The tools/list answer: one static array, built once, identical on every call. */
const TOOLS_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function handleRequest(forge: Forge, request: Record<string, unknown>): RpcOutcome | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined) return null; // a notification: answered by the transport, not a result

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = tool.run(forge, args);
      if ('error' in outcome) {
        // A missing required argument is a protocol-level -32602; a domain failure (a missing
        // repository, a refused merge) is a tool execution error the caller can read.
        if (outcome.error.startsWith('missing required argument')) return rpcError(id, -32602, outcome.error);
        return rpcResult(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
      }
      return rpcResult(id, { content: outcome.content, structuredContent: outcome.structured, isError: false });
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (req.method === 'DELETE') {
    // A legacy session close: no session is held in the modern era, so there is nothing to do.
    sendJson(res, 200, {});
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => (typeof entry === 'object' && entry !== null ? handleRequest(forge, entry as Record<string, unknown>) : null))
      .filter((entry) => entry !== null)
      .map((entry) => entry!.payload);
    sendJson(res, 200, answers);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const outcome = handleRequest(forge, parsed as Record<string, unknown>);
  if (outcome === null) {
    // A notification: accepted, no body (the client reads no result from it).
    res.writeHead(202, { 'x-github-request-id': 'req-notification' });
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.payload);
}
