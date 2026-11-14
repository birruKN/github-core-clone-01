// GraphQL v4 at POST /api/graphql: a small parser and executor for the schema surface the
// suite's documents use (gh's and github-mcp-server's githubv4 shapes) — viewer, repository,
// issues and pull requests with connections and cursors, the five mutations, Relay node ids,
// operation batching, and the __type introspection probes. It executes over the same store
// as REST, so a mutation here is a REST-visible fact there.
//
// Wire rules: an unauthenticated request is exactly 401; a GraphQL-level failure (an unknown
// field) is a 200 carrying an `errors` array whose message names the field; an unknown
// repository is data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  globalId,
  parseGlobalId,
  pullMergeable,
  squashMerge,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { createIssueRecord, createPullRecord, pullFiles } from './rest.ts';
import { authorized, sendJson } from './http.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer and parser (the GraphQL subset the documents use)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const value = end < 0 ? source.slice(index + 3) : source.slice(index + 3, end);
        tokens.push({ kind: 'string', value });
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const esc = source[index + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index))!;
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      index += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    index += 1; // an unknown character cannot wedge the parser
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected '${value}' in the GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the GraphQL document');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipBalanced('(', ')'); // variable definitions: parsed for shape, values come from the request
        operations.push({ operation: keyword, name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('a fragment definition needs a type condition');
        const typeCondition = this.expectName();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unsupported GraphQL definition '${keyword}'`);
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') return;
      if (token.kind === 'punct' && token.value === open) depth += 1;
      if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.atPunct('...')) {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
          selections.push({ kind: 'spread', name: this.expectName() });
        } else {
          let typeCondition: string | null = null;
          if (this.peek().kind === 'name') {
            this.expectName(); // 'on'
            typeCondition = this.expectName();
          }
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.eatPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args: Record<string, ValueNode> = {};
      if (this.eatPunct('(')) {
        while (!this.atPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      if (this.atPunct('@')) {
        // A directive: skip its name and any argument list (none of the suite's documents use one).
        this.next();
        this.expectName();
        if (this.atPunct('(')) this.skipBalanced('(', ')');
      }
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'literal', value: token.value };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value }; // an enum value rides as its name
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.atPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in the GraphQL document');
  }
}

// ---------------------------------------------------------------------------------------------
// the schema the executor knows (field lists double as the introspection answers)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository', 'additions', 'deletions', 'changedFiles',
  ],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'interfaces'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'USER', 'REPOSITORY', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

type Source = Record<string, unknown> & { __typename: string };

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

interface FieldDef {
  type: string;
  resolve: (ctx: Ctx, source: Source, args: Record<string, unknown>) => unknown;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'literal':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: IssueRec): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: PullRec): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = forge.findRepoById(Number(repoId));
  const issue = repo?.issues.get(Number(number));
  return repo && issue ? { repo, issue } : null;
}

function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = forge.findRepoById(Number(repoId));
  const pull = repo?.pulls.get(Number(number));
  return repo && pull ? { repo, pull } : null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

const FIELD_DEFS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: () => ({ __typename: 'User', login: VIEWER.login }) },
    repository: {
      type: 'Repository',
      resolve: (ctx, _source, args) => {
        const repo = typeof args.name === 'string' ? ctx.forge.getRepo(String(args.owner ?? ''), args.name) : undefined;
        return repo ? repoSource(repo) : null;
      },
    },
    node: {
      type: 'Node',
      resolve: (ctx, _source, args) => {
        if (typeof args.id !== 'string') return null;
        const parsed = parseGlobalId(args.id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = ctx.forge.findRepoById(Number(parsed.key));
          return repo ? repoSource(repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const found = findIssueByGlobalId(ctx.forge, args.id);
          return found ? issueSource(found.repo, found.issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const found = findPullByGlobalId(ctx.forge, args.id);
          return found ? pullSource(found.repo, found.pull) : null;
        }
        if (parsed.kind === 'User') return { __typename: 'User', login: VIEWER.login };
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_ctx, _source, args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (name in TYPE_FIELDS || name in ENUM_VALUES) return { __typename: '__Type', name };
        return null;
      },
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        const repo = parsed && parsed.kind === 'Repository' ? ctx.forge.findRepoById(Number(parsed.key)) : undefined;
        if (!repo) throw new Error('createIssue: the repository id names no repository');
        const issue = createIssueRecord(ctx.forge, repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          labels: [],
        });
        return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.issueId === 'string' ? findIssueByGlobalId(ctx.forge, input.issueId) : null;
        if (!found) throw new Error('closeIssue: the issue id names no issue');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        const repo = parsed && parsed.kind === 'Repository' ? ctx.forge.findRepoById(Number(parsed.key)) : undefined;
        if (!repo) throw new Error('createPullRequest: the repository id names no repository');
        const created = createPullRecord(ctx.forge, repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          headRef: typeof input.headRefName === 'string' ? input.headRefName.replace(/^refs\/heads\//, '') : '',
          baseRef: typeof input.baseRefName === 'string' ? input.baseRefName.replace(/^refs\/heads\//, '') : repo.defaultBranch,
        });
        if ('error' in created) throw new Error(`createPullRequest: ${created.error}`);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, created) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(ctx.forge, input.pullRequestId) : null;
        if (!found) throw new Error('mergePullRequest: the pull request id names no pull request');
        const outcome = squashMerge(ctx.forge, found.repo, found.pull);
        if (outcome.status === 'conflict') throw new Error('mergePullRequest: the pull request is not mergeable (conflict)');
        if (outcome.status === 'missing') throw new Error('mergePullRequest: a branch is missing');
        return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(ctx.forge, input.subjectId) : null;
        if (!found) throw new Error('addComment: the subject id names no issue');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = { id: ctx.forge.entityId(), body, seq: found.issue.comments.length };
        found.issue.comments.push(comment);
        const node: Source = {
          __typename: 'Comment',
          id: globalId('Comment', `${found.repo.id}:${comment.id}`),
          body,
        };
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
      },
    },
  },
  User: {
    login: { type: 'String', resolve: (_ctx, source) => source.login },
    id: { type: 'ID', resolve: () => globalId('User', String(VIEWER.id)) },
    name: { type: 'String', resolve: () => VIEWER.name },
    email: { type: 'String', resolve: () => VIEWER.email },
  },
  Repository: {
    id: { type: 'ID', resolve: (_ctx, source) => globalId('Repository', String((source.repo as Repo).id)) },
    databaseId: { type: 'Int', resolve: (_ctx, source) => (source.repo as Repo).id },
    name: { type: 'String', resolve: (_ctx, source) => (source.repo as Repo).name },
    nameWithOwner: { type: 'String', resolve: (_ctx, source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}` },
    owner: { type: 'User', resolve: (_ctx, source) => ({ __typename: 'User', login: (source.repo as Repo).owner }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (_ctx, source) => {
        const repo = source.repo as Repo;
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    description: { type: 'String', resolve: (_ctx, source) => (source.repo as Repo).description },
    isPrivate: { type: 'Boolean', resolve: (_ctx, source) => (source.repo as Repo).isPrivate },
    issue: {
      type: 'Issue',
      resolve: (_ctx, source, args) => {
        const repo = source.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueSource(repo, issue) : null;
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (_ctx, source, args) => {
        const repo = source.repo as Repo;
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states.map(String) : null;
        if (states !== null) {
          list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
        if (orderBy !== null) {
          list.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        } else {
          list.sort((a, b) => a.seq - b.seq);
        }
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
        const start = indexFromCursor(args.after);
        const page = list.slice(start, start + first);
        const connection: Source = {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueSource(repo, issue)),
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: start + page.length < list.length,
            endCursor: cursorFor(start + page.length),
            hasPreviousPage: start > 0,
            startCursor: cursorFor(start),
          },
          totalCount: list.length,
        };
        return connection;
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (_ctx, source, args) => {
        const repo = source.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullSource(repo, pull) : null;
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (_ctx, source, args) => {
        const repo = source.repo as Repo;
        let list = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? args.states.map(String) : null;
        if (states !== null) {
          list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        list.sort((a, b) => b.seq - a.seq);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
        return { __typename: 'PullRequestConnection', nodes: list.slice(0, first).map((pull) => pullSource(repo, pull)), totalCount: list.length };
      },
    },
  },
  Issue: {
    id: { type: 'ID', resolve: (_ctx, source) => globalId('Issue', `${(source.repo as Repo).id}:${(source.issue as IssueRec).number}`) },
    number: { type: 'Int', resolve: (_ctx, source) => (source.issue as IssueRec).number },
    title: { type: 'String', resolve: (_ctx, source) => (source.issue as IssueRec).title },
    state: { type: 'String', resolve: (_ctx, source) => ((source.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED') },
    body: { type: 'String', resolve: (_ctx, source) => (source.issue as IssueRec).body },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (_ctx, source) => globalId('PullRequest', `${(source.repo as Repo).id}:${(source.pull as PullRec).number}`) },
    number: { type: 'Int', resolve: (_ctx, source) => (source.pull as PullRec).number },
    title: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRec).title },
    body: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRec).body },
    state: {
      type: 'String',
      resolve: (_ctx, source) => {
        const pull = source.pull as PullRec;
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      },
    },
    merged: { type: 'Boolean', resolve: (_ctx, source) => (source.pull as PullRec).merged },
    headRefName: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRec).headRef },
    baseRefName: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRec).baseRef },
    mergeable: { type: 'String', resolve: (_ctx, source) => pullMergeable(source.repo as Repo, source.pull as PullRec) },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (_ctx, source, args) => {
        const repo = source.repo as Repo;
        const pull = source.pull as PullRec;
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 10;
        const nodes = pullFiles(repo, pull)
          .slice(0, first)
          .map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions }));
        return { __typename: 'PullRequestChangedFileConnection', nodes };
      },
    },
  },
  Ref: {
    name: { type: 'String', resolve: (_ctx, source) => source.name },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (_ctx, source) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source) => source.pageInfo },
    totalCount: { type: 'Int', resolve: (_ctx, source) => source.totalCount },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (_ctx, source) => source.nodes },
    totalCount: { type: 'Int', resolve: (_ctx, source) => source.totalCount },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (_ctx, source) => source.nodes },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (_ctx, source) => source.hasNextPage },
    endCursor: { type: 'String', resolve: (_ctx, source) => source.endCursor },
    hasPreviousPage: { type: 'Boolean', resolve: (_ctx, source) => source.hasPreviousPage },
    startCursor: { type: 'String', resolve: (_ctx, source) => source.startCursor },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (_ctx, source) => source.path },
    additions: { type: 'Int', resolve: (_ctx, source) => source.additions },
    deletions: { type: 'Int', resolve: (_ctx, source) => source.deletions },
  },
  Comment: {
    id: { type: 'ID', resolve: (_ctx, source) => source.id },
    body: { type: 'String', resolve: (_ctx, source) => source.body },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source) => source.issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source) => source.issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source) => source.pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source) => source.pullRequest },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (_ctx, source) => source.commentEdge },
  },
  CommentEdge: {
    node: { type: 'Comment', resolve: (_ctx, source) => source.node },
  },
  __Type: {
    name: { type: 'String', resolve: (_ctx, source) => source.name },
    kind: {
      type: 'String',
      resolve: (_ctx, source) => (typeof source.name === 'string' && source.name in ENUM_VALUES ? 'ENUM' : 'OBJECT'),
    },
    fields: {
      type: '[__Field]',
      resolve: (_ctx, source) => {
        const names = typeof source.name === 'string' ? TYPE_FIELDS[source.name] : undefined;
        return names ? names.map((name) => ({ __typename: '__Field', name })) : null;
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (_ctx, source) => {
        const values = typeof source.name === 'string' ? ENUM_VALUES[source.name] : undefined;
        return values ? values.map((name) => ({ __typename: '__EnumValue', name })) : null;
      },
    },
  },
  __Field: {
    name: { type: 'String', resolve: (_ctx, source) => source.name },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (_ctx, source) => source.name },
  },
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function executeSelectionSet(ctx: Ctx, typeName: string, source: Source, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      const fragment = selection.kind === 'inline' ? selection : ctx.fragments.get(selection.name);
      if (!fragment) continue;
      const condition = fragment.typeCondition;
      if (condition === null || condition === typeName || condition === source.__typename || typeName === 'Node') {
        Object.assign(out, executeSelectionSet(ctx, source.__typename, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    const def = FIELD_DEFS[typeName]?.[selection.name] ?? (typeName === 'Node' ? FIELD_DEFS[source.__typename]?.[selection.name] : undefined);
    if (!def) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argNode] of Object.entries(selection.args)) args[argName] = valueOf(argNode, ctx.variables);
    let raw: unknown;
    try {
      raw = def.resolve(ctx, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, def.type, raw, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: Ctx, type: string, raw: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (raw === null || raw === undefined) return null;
  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1);
    return Array.isArray(raw) ? raw.map((item) => completeValue(ctx, inner, item, selectionSet)) : null;
  }
  if (SCALARS.has(type)) return raw;
  if (selectionSet === null) return raw;
  const source = raw as Source;
  return executeSelectionSet(ctx, type === 'Node' ? source.__typename : type, source, selectionSet);
}

function executeOperation(
  forge: Forge,
  document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> },
  operationName: string | null,
  variables: Record<string, unknown>,
): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const operation =
    document.operations.find((candidate) => operationName !== null && candidate.name === operationName) ?? document.operations[0];
  if (!operation) return { data: {}, errors: [{ message: 'the document holds no operation' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Source = { __typename: rootType };
  const data = executeSelectionSet(ctx, rootType, root, operation.selectionSet);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------------------------------------
// the HTTP entry point
// ---------------------------------------------------------------------------------------------

export function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'the request body is not JSON' }] });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'an operation must be an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    try {
      const document = new Parser(query).parseDocument();
      return executeOperation(forge, document, operationName, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
