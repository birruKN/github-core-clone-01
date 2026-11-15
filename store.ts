// The forge's store and domain core: git objects, refs, repositories, issues, pull requests,
// labels and comments, all in memory, all shared by the four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) so an object created on one surface is the same object on every other.
//
// Determinism: nothing here reads the wall clock or a random source. Commit timestamps and
// created_at values come from a logical clock (a counter over a fixed epoch), so identical
// request sequences produce byte-identical objects, and therefore identical SHA-1 ids.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The one user the trial token names (wire.ts's seeded scenario viewer). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------------------------------------
// object hashing and the commit/tree/tag codecs
// ---------------------------------------------------------------------------------------------

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

/**
 * parseCommit memoized per repository (defined below, next to the Repo record): commit
 * objects are immutable and content-addressed, so a parsed view can never go stale. The
 * shared view is read-only for callers — every existing caller only reads its fields.
 */

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`, `committer ${fields.committer} ${fields.timestamp} +0000`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const out = { object: '', type: '', tag: '' };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') out.object = value;
    else if (key === 'type') out.type = value;
    else if (key === 'tag') out.tag = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  /** Cached REST serialization of this issue (JSON text, no trailing newline). The REST view
   *  is a pure function of the record plus the repo's label colors, so the cached text is
   *  byte-identical to a fresh serialization; every mutation site clears it via
   *  invalidateIssueView. */
  viewText?: string;
}

/** Drop an issue's cached REST serialization after any change to the record. */
export function invalidateIssueView(issue: IssueRec): void {
  issue.viewText = undefined;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
  /** Memoized ancestor sets per commit (content-addressed, so they never go stale). */
  ancestorCache: Map<string, Set<string>>;
  /** Memoized parseCommit views per commit (same immutability argument). */
  commitParseCache: Map<string, CommitView>;
  /** Bumped on every ref mutation; keys the ls-refs reply cache below. */
  refsVersion: number;
  /** The last ls-refs reply built for this repo, with the cache key it answers. */
  lsRefsCache: { key: string; body: Buffer } | null;
}

/** Record a ref mutation: anything derived from the ref set (ls-refs replies) is stale now. */
export function touchRefs(repo: Repo): void {
  repo.refsVersion += 1;
}

const CLOCK_EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z, the fixture epoch's neighbourhood

export class Forge {
  readonly repos = new Map<string, Repo>();
  /** Memoized v2 fetch replies, keyed by repo incarnation + the request's object ids. A fetch
   *  reply is a pure function of content-addressed objects, so a hit is byte-identical. */
  readonly fetchCache = new Map<string, Buffer>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private clock = 0;

  /** The next logical timestamp (seconds), strictly increasing across the whole forge. */
  tick(): number {
    this.clock += 1;
    return CLOCK_EPOCH + this.clock;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  entityId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  createRepo(owner: string, name: string, options: { isPrivate?: boolean; description?: string }): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.repos.size,
      ancestorCache: new Map(),
      commitParseCache: new Map(),
      refsVersion: 0,
      lsRefsCache: null,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// ---------------------------------------------------------------------------------------------
// object store operations on one repository
// ---------------------------------------------------------------------------------------------

export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Follow tag objects to the commit they name; null when the chain does not end at a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a ref-ish names: a full ref, a short branch/tag name, or a raw object id. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const branch = `refs/heads/${ref}`;
  if (repo.refs.has(branch)) return repo.refs.get(branch)!;
  const tag = `refs/tags/${ref}`;
  if (repo.refs.has(tag)) return repo.refs.get(tag)!;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Every commit reachable from `tip` (inclusive), with its BFS depth from `tip`. */
export function commitAncestors(repo: Repo, tip: string): Map<string, number> {
  const depths = new Map<string, number>();
  const start = peelToCommit(repo, tip);
  if (start === null) return depths;
  depths.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    const depth = depths.get(current)!;
    const view = parseCommitCached(repo, current);
    if (!view) continue;
    for (const parent of view.parents) {
      if (!depths.has(parent)) {
        depths.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return depths;
}

/** parseCommit through the repo's memo; null when the id is not a stored commit. */
export function parseCommitCached(repo: Repo, oid: string): CommitView | null {
  const cached = repo.commitParseCache.get(oid);
  if (cached) return cached;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  if (repo.commitParseCache.size < 20000) repo.commitParseCache.set(oid, view);
  return view;
}

/**
 * The set of commits reachable from `tip` (inclusive), memoized per commit: objects are
 * content-addressed and immutable, so a cached set can never go stale, and a long push chain
 * costs one set union per new commit instead of a full history walk per push.
 */
export function ancestorSet(repo: Repo, tip: string): Set<string> {
  const start = peelToCommit(repo, tip);
  if (start === null) return new Set();
  const cached = repo.ancestorCache.get(start);
  if (cached) return cached;
  const result = new Set<string>([start]);
  const view = parseCommitCached(repo, start);
  if (view) {
    for (const parent of view.parents) {
      for (const ancestor of ancestorSet(repo, parent)) result.add(ancestor);
    }
  }
  if (repo.ancestorCache.size < 20000) repo.ancestorCache.set(start, result);
  return result;
}

/**
 * Reachability of `ancestor` from `descendant` by parent walking with early exit: the
 * common fast-forward question ("is the old tip on the new tip's first steps back?") is
 * answered in a step or two, where building the full ancestor set costs O(history) with a
 * set union per commit. A visited set keeps merge-heavy histories linear.
 */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const anc = peelToCommit(repo, ancestor);
  const desc = peelToCommit(repo, descendant);
  if (anc === null || desc === null) return false;
  if (anc === desc) return true;
  const seen = new Set<string>([desc]);
  const queue = [desc];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const view = parseCommitCached(repo, current);
    if (!view) continue;
    for (const parent of view.parents) {
      if (parent === anc) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The best common ancestor of two commits (the one with the smallest combined depth). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = commitAncestors(repo, a);
  const fromB = commitAncestors(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** The full object closure of `tips` that lives in the store (missing objects are skipped). */
export function reachableObjects(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) if (isOid(tip)) queue.push(tip);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommitCached(repo, oid);
      if (commit) {
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// trees as flat file maps
// ---------------------------------------------------------------------------------------------

export interface FileEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> blob. A null tree is the empty map. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  if (treeOid === null) return files;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/** Build (and store) the nested tree objects for a flat path -> blob map; returns the root tree id. */
export function treeFromFiles(repo: Repo, files: ReadonlyMap<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree of a commit object, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const view = parseCommitCached(repo, commitOid);
  return view ? view.tree : null;
}

/**
 * Apply file changes (path -> new blob content, or null to delete) on top of a branch's current
 * tree, commit them as the viewer, and move the branch. Returns the new commit id. Works on an
 * unborn branch (the commit is then a root commit).
 */
export function commitFiles(
  forge: Forge,
  repo: Repo,
  options: { branch: string; changes: ReadonlyMap<string, Buffer | null>; message: string },
): string {
  const ref = `refs/heads/${options.branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const files = flattenTree(repo, tip === null ? null : commitTree(repo, peelToCommit(repo, tip) ?? ''));
  for (const [path, content] of options.changes) {
    if (content === null) files.delete(path);
    else files.set(path, { oid: storeObject(repo, 'blob', content), mode: '100644' });
  }
  const tree = treeFromFiles(repo, files);
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const timestamp = forge.tick();
  const commit = storeObject(
    repo,
    'commit',
    buildCommit({
      tree,
      parents: tip === null ? [] : [peelToCommit(repo, tip) ?? tip],
      message: options.message,
      author: identity,
      committer: identity,
      timestamp,
    }),
  );
  repo.refs.set(ref, commit);
  touchRefs(repo);
  return commit;
}

// ---------------------------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level additions/deletions between two texts (an LCS diff; a size-capped fallback). */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  return object && object.type === 'blob' ? object.data.toString('utf8') : '';
}

/** The file-level diff between two flat file maps (from -> to). */
export function diffFileMaps(repo: Repo, from: ReadonlyMap<string, FileEntry>, to: ReadonlyMap<string, FileEntry>): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (!before && after) {
      const additions = splitLines(blobText(repo, after.oid)).length;
      diffs.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before && !after) {
      const deletions = splitLines(blobText(repo, before.oid)).length;
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before && after) {
      const { additions, deletions } = lineDiff(blobText(repo, before.oid), blobText(repo, after.oid));
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

/**
 * A three-way tree merge at blob granularity: a path conflicts only when both sides changed it
 * away from the merge-base version in different ways. Answers the merged file map, or null on
 * conflict.
 */
export function mergeFileMaps(
  ancestor: ReadonlyMap<string, FileEntry>,
  base: ReadonlyMap<string, FileEntry>,
  head: ReadonlyMap<string, FileEntry>,
): Map<string, FileEntry> | null {
  const merged = new Map<string, FileEntry>();
  const paths = new Set<string>([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const anc = ancestor.get(path)?.oid;
    const bs = base.get(path)?.oid;
    const hd = head.get(path)?.oid;
    if (bs === hd) {
      const winner = base.get(path) ?? head.get(path);
      if (winner) merged.set(path, winner);
    } else if (anc === bs) {
      const winner = head.get(path);
      if (winner) merged.set(path, winner);
    } else if (anc === hd) {
      const winner = base.get(path);
      if (winner) merged.set(path, winner);
    } else {
      return null;
    }
  }
  return merged;
}

export type MergeOutcome =
  | { status: 'merged'; sha: string }
  | { status: 'conflict' }
  | { status: 'missing' };

/**
 * Squash-merge a pull request: the head's changes relative to the merge base are applied onto
 * the base branch as one new commit whose parent is the base tip. On success the pull is closed,
 * marked merged, and the base ref moves.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: PullRec): MergeOutcome {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { status: 'missing' };
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return { status: 'missing' };
  const ancestor = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  const merged = mergeFileMaps(
    flattenTree(repo, commitTree(repo, ancestor)),
    flattenTree(repo, commitTree(repo, baseCommit)),
    flattenTree(repo, commitTree(repo, headCommit)),
  );
  if (merged === null) return { status: 'conflict' };
  const tree = treeFromFiles(repo, merged);
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
  const sha = storeObject(
    repo,
    'commit',
    buildCommit({ tree, parents: [baseCommit], message, author: identity, committer: identity, timestamp: forge.tick() }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  touchRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.isoNow();
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return { status: 'merged', sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's `mergeable`). */
export function pullMergeable(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'CONFLICTING';
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return 'CONFLICTING';
  const ancestor = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  const merged = mergeFileMaps(
    flattenTree(repo, commitTree(repo, ancestor)),
    flattenTree(repo, commitTree(repo, baseCommit)),
    flattenTree(repo, commitTree(repo, headCommit)),
  );
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------------------------
// global ids (GraphQL's Relay-style node ids: opaque, stable, never the plain database id)
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
