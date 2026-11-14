// The REST v3 surface under /api/v3: repositories, contents, git refs, branches, commits,
// labels, issues, comments and pull requests, in GitHub's shapes and with GitHub's statuses.
// One store underneath (store.ts), so everything created here is immediately visible to the
// git, GraphQL and MCP surfaces.
//
// The wire rules the protocol checks sample: every reply is application/json with a non-empty
// X-GitHub-Request-Id (http.ts), errors are {"message": ...}, no token is 401, a repository
// under another owner is 404 (never 403), an unknown route is a JSON 404, a malformed JSON
// body is a 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  branchTip,
  commitFiles,
  commitTree,
  diffFileMaps,
  flattenTree,
  getObject,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  resolveRef,
  squashMerge,
  storeObject,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { authorized, originOf, sendEmpty, sendJson } from './http.ts';

type Json = Record<string, unknown>;

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function validationFailed(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

function repoView(repo: Repo): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id },
  };
}

function issueView(repo: Repo, issue: IssueRec): Json {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner },
    comments: issue.comments.length,
  };
}

function pullView(repo: Repo, pull: PullRec): Json {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner },
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const { page, perPage } = parsePage(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The tree (flattened) a ref-ish names in this repo, or null when it names nothing. */
function filesAtRef(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  const commit = peelToCommit(repo, oid);
  if (commit === null) return null;
  return flattenTree(repo, commitTree(repo, commit));
}

function normalizeBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// ---------------------------------------------------------------------------------------------
// repository-scoped routes
// ---------------------------------------------------------------------------------------------

function handleRepoRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: Json,
): void {
  const method = req.method ?? 'GET';
  const head = rest[0] ?? '';

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        // A rename moves the map key; nothing in the suite renames, but stay consistent.
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, 204);
      return;
    }
    notFound(res);
    return;
  }

  // /contents/{path...}
  if (head === 'contents') {
    handleContents(forge, req, res, repo, rest.slice(1).join('/'), query, body);
    return;
  }

  // /git/refs[/{ref...}]
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (ref === '' || !getObject(repo, sha)) {
        validationFailed(res, 'Validation Failed: ref and a known sha are required');
        return;
      }
      const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      if (repo.refs.has(full)) {
        validationFailed(res, 'Reference already exists');
        return;
      }
      repo.refs.set(full, sha);
      sendJson(res, 201, { ref: full, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && rest.length > 2) {
      const wanted = rest.slice(2).join('/');
      const full = wanted.startsWith('refs/') ? wanted : `refs/${wanted}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: full, object: { sha, type: 'commit' } });
      return;
    }
    notFound(res);
    return;
  }

  // /branches[/{name...}]
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, paginate(branches, query));
      return;
    }
    if (method === 'GET' && rest.length > 1) {
      const name = rest.slice(1).join('/');
      const sha = branchTip(repo, name);
      if (sha === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name, commit: { sha } });
      return;
    }
    notFound(res);
    return;
  }

  // /commits
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tipOid = resolveRef(repo, ref);
    const tip = tipOid === null ? null : peelToCommit(repo, tipOid);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const commits: Json[] = [];
    const seen = new Set<string>();
    const walk = (oid: string): void => {
      if (seen.has(oid) || commits.length >= 100) return;
      const object = getObject(repo, oid);
      if (!object || object.type !== 'commit') return;
      seen.add(oid);
      const commit = parseCommit(object.data);
      commits.push({
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: { name: VIEWER.name, email: VIEWER.email },
          committer: { name: VIEWER.name, email: VIEWER.email },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
      for (const parent of commit.parents) walk(parent);
    };
    walk(tip);
    sendJson(res, 200, commits);
    return;
  }

  // /labels
  if (head === 'labels' && rest.length === 1 && method === 'POST') {
    const name = typeof body.name === 'string' ? body.name : '';
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    if (name === '') {
      validationFailed(res, 'Validation Failed: name is required');
      return;
    }
    if (repo.labels.has(name)) {
      validationFailed(res, 'Validation Failed: label already exists');
      return;
    }
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color });
    return;
  }

  // /issues...
  if (head === 'issues') {
    handleIssues(forge, req, res, repo, rest.slice(1), query, body);
    return;
  }

  // /pulls...
  if (head === 'pulls') {
    handlePulls(forge, req, res, repo, rest.slice(1), query, body);
    return;
  }

  notFound(res);
}

function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
  body: Json,
): void {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const files = filesAtRef(repo, ref);
    if (files === null) {
      notFound(res);
      return;
    }
    const file = files.get(path);
    if (file) {
      const object = getObject(repo, file.oid);
      const data = object && object.type === 'blob' ? object.data : Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop() ?? path,
        path,
        sha: file.oid,
        size: data.length,
        content: data.toString('base64'),
      });
      return;
    }
    // A directory: its immediate entries.
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const tail = filePath.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash < 0) entries.set(tail, { type: 'file', sha: entry.oid });
      else {
        const dir = tail.slice(0, slash);
        if (!entries.has(dir)) {
          const dirTree = treeOidAtPath(repo, ref, prefix + dir);
          entries.set(dir, { type: 'dir', sha: dirTree ?? '' });
        }
      }
    }
    if (entries.size === 0 && path !== '') {
      notFound(res);
      return;
    }
    const listing = [...entries.entries()]
      .map(([name, entry]) => ({ type: entry.type, name, path: prefix + name, sha: entry.sha }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, listing);
    return;
  }

  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const encoded = typeof body.content === 'string' ? body.content : '';
    const content = Buffer.from(encoded.replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    const existing = tip === null ? undefined : filesAtRef(repo, branch)?.get(path);
    if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendJson(res, 409, { message: 'Conflict: the sha does not match the current file' });
      return;
    }
    if (tip === null && branch !== repo.defaultBranch) {
      // The contents route doubles as the branch-creation route (the MCP setup relies on it
      // when /git/refs is unavailable): seed the new branch from the default branch's files.
      const baseTip = branchTip(repo, repo.defaultBranch);
      if (baseTip !== null) {
        const baseFiles = filesAtRef(repo, repo.defaultBranch) ?? new Map();
        const seeded = new Map<string, Buffer | null>();
        for (const [filePath, entry] of baseFiles) {
          const object = getObject(repo, entry.oid);
          if (object && object.type === 'blob') seeded.set(filePath, object.data);
        }
        if (seeded.size > 0) commitFiles(forge, repo, { branch, changes: seeded, message: 'Seed branch' });
      }
    }
    const commit = commitFiles(forge, repo, { branch, changes: new Map([[path, content]]), message });
    const blobOid = storeObject(repo, 'blob', content);
    sendJson(res, existing ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit },
    });
    return;
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const existing = filesAtRef(repo, branch)?.get(path);
    if (!existing) {
      notFound(res);
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendJson(res, 409, { message: 'Conflict: the sha does not match the current file' });
      return;
    }
    const commit = commitFiles(forge, repo, { branch, changes: new Map([[path, null]]), message });
    sendJson(res, 200, { content: null, commit: { sha: commit } });
    return;
  }

  notFound(res);
}

/** The subtree oid at a directory path on a ref, for directory listings. */
function treeOidAtPath(repo: Repo, ref: string, dirPath: string): string | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  const commit = peelToCommit(repo, oid);
  if (commit === null) return null;
  let tree = commitTree(repo, commit);
  if (tree === null) return null;
  for (const segment of dirPath.split('/').filter(Boolean)) {
    const object = getObject(repo, tree);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    tree = entry.oid;
  }
  return tree;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function createIssueRecord(forge: Forge, repo: Repo, input: { title: string; body: string; labels: string[] }): IssueRec {
  const issue: IssueRec = {
    kind: 'issue',
    id: forge.entityId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    seq: repo.nextNumber,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function labelError(repo: Repo, labels: readonly string[]): string | null {
  for (const label of labels) {
    if (!repo.labels.has(label)) return `Validation Failed: label '${label}' does not exist`;
  }
  return null;
}

function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: Json,
): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const text = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      const error = labelError(repo, labels);
      if (error !== null) {
        validationFailed(res, error);
        return;
      }
      const issue = createIssueRecord(forge, repo, { title, body: text, labels });
      sendJson(res, 201, issueView(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      if (query.get('sort') !== null) {
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      } else {
        issues.sort((a, b) => a.seq - b.seq);
      }
      sendJson(res, 200, paginate(issues, query).map((issue) => issueView(repo, issue)));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(rest[0] ?? '', 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (!issue) {
    notFound(res);
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueView(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((label): label is string => typeof label === 'string');
        const error = labelError(repo, labels);
        if (error !== null) {
          validationFailed(res, error);
          return;
        }
        issue.labels = labels;
      }
      sendJson(res, 200, issueView(repo, issue));
      return;
    }
    notFound(res);
    return;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      const comment = { id: forge.entityId(), body: text, seq: issue.comments.length };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: repo.owner } });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, paginate(issue.comments, query).map((comment) => ({ id: comment.id, body: comment.body, user: { login: repo.owner } })));
      return;
    }
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

export function createPullRecord(
  forge: Forge,
  repo: Repo,
  input: { title: string; body: string; headRef: string; baseRef: string },
): PullRec | { error: string } {
  const headTip = branchTip(repo, input.headRef);
  const baseTip = branchTip(repo, input.baseRef);
  if (headTip === null || baseTip === null) return { error: 'Validation Failed: head or base branch does not exist' };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === input.headRef && pull.baseRef === input.baseRef) {
      return { error: 'Validation Failed: a pull request already exists for this branch combination' };
    }
  }
  const pull: PullRec = {
    kind: 'pull',
    id: forge.entityId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.headRef,
    baseRef: input.baseRef,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: repo.nextNumber,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The changed files of a pull request: the diff from its merge base to its head. */
export function pullFiles(repo: Repo, pull: PullRec): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const ancestor = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  const from = flattenTree(repo, commitTree(repo, ancestor));
  const to = flattenTree(repo, commitTree(repo, headCommit));
  return diffFileMaps(repo, from, to);
}

function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: Json,
): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const text = typeof body.body === 'string' ? body.body : '';
      const headRef = normalizeBranch(typeof body.head === 'string' ? body.head : '');
      const baseRef = normalizeBranch(typeof body.base === 'string' ? body.base : repo.defaultBranch);
      const created = createPullRecord(forge, repo, { title, body: text, headRef, baseRef });
      if ('error' in created) {
        validationFailed(res, created.error);
        return;
      }
      sendJson(res, 201, pullView(repo, created));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.seq - b.seq);
      sendJson(res, 200, paginate(pulls, query).map((pull) => pullView(repo, pull)));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(rest[0] ?? '', 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (!pull) {
    notFound(res);
    return;
  }
  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, pullView(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, paginate(pullFiles(repo, pull), query));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable: it was already merged' });
      return;
    }
    const outcome = squashMerge(forge, repo, pull);
    if (outcome.status === 'conflict') {
      sendJson(res, 405, { message: 'Pull Request is not mergeable: merge conflict' });
      return;
    }
    if (outcome.status === 'missing') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// the /api/v3 entry point
// ---------------------------------------------------------------------------------------------

export function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: Json,
): void {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const method = req.method ?? 'GET';

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', git_version: 'forge-1.0' });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET' && segments.length === 2) {
      const all = forge.listRepos(VIEWER.login);
      const { page, perPage } = parsePage(query);
      const pages = Math.max(1, Math.ceil(all.length / perPage));
      const headers: Record<string, string> = {};
      if (page < pages) {
        const origin = originOf(req);
        const links = [
          `<${origin}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`,
          `<${origin}/api/v3/user/repos?page=${pages}&per_page=${perPage}>; rel="last"`,
        ];
        if (page > 1) {
          links.push(`<${origin}/api/v3/user/repos?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
          links.push(`<${origin}/api/v3/user/repos?page=1&per_page=${perPage}>; rel="first"`);
        }
        headers.link = links.join(', ');
      }
      sendJson(res, 200, paginate(all, query).map(repoView), headers);
      return;
    }
    if (method === 'POST' && segments.length === 2) {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        validationFailed(res, 'Validation Failed: name is required');
        return;
      }
      const repo = forge.createRepo(VIEWER.login, name, {
        isPrivate: typeof body.private === 'boolean' ? body.private : false,
        description: typeof body.description === 'string' ? body.description : '',
      });
      if (repo === null) {
        validationFailed(res, 'name already exists on this account');
        return;
      }
      sendJson(res, 201, repoView(repo));
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    const repo = owner === VIEWER.login ? forge.getRepo(owner, name) : undefined;
    if (!repo) {
      notFound(res);
      return;
    }
    handleRepoRoute(forge, req, res, repo, segments.slice(3), query, body);
    return;
  }

  notFound(res);
}

export { repoView, issueView, pullView, createIssueRecord };
