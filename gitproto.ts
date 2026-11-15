// Git smart HTTP: protocol v2 upload-pack (advertisement, ls-refs, fetch with shallow support)
// and v0 receive-pack (push with report-status), over the store's own object model. No git
// binary exists in the trial pod and none is needed: packs are built and read in-process.
//
// The wire shapes here are the ones the suite's in-process client (git-client.ts) speaks:
//   - a v2 advertisement is `version 2` plus capability lines; receive-pack stays v0, opening
//     with the `# service=` preamble and the capabilities after a NUL on the first ref line;
//   - a v2 fetch answers in named sections (acknowledgments, shallow-info, packfile), the
//     packfile section sideband-framed (band 1 = pack bytes);
//   - a push answers a pkt-framed report-status stream, sideband-wrapped when negotiated.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  hashObject,
  isAncestor,
  isOid,
  parseCommitCached,
  parseTag,
  parseTree,
  peelToCommit,
  reachableObjects,
  storeObject,
  touchRefs,
  type Forge,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';
import { authorized, sendBytes, sendJson } from './http.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

const PKT_MAX_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktReader {
  /** The next data payload, 'flush'/'delim' for control packets, or null at the end. */
  next(): string | Buffer | 'flush' | 'delim' | null;
  /** The unconsumed remainder (a push's pack follows its command list here). */
  rest(): Buffer;
}

/** Parse a fully buffered pkt-line stream; refuses a malformed header like the client does. */
export function pktReader(bytes: Buffer): PktReader | null {
  let offset = 0;
  return {
    next() {
      if (offset >= bytes.length) return null;
      if (offset + 4 > bytes.length) return null;
      const header = bytes.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        return 'flush';
      }
      if (length === 1) {
        offset += 4;
        return 'delim';
      }
      if (length === 2) {
        offset += 4;
        return 'delim';
      }
      if (length < 4 || offset + length > bytes.length) return null;
      const payload = bytes.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest() {
      return bytes.subarray(offset);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// packfiles: write (plain objects) and read (with OFS/REF delta resolution)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain (undelta'd) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  try {
    const sourceSize = readSize();
    const targetSize = readSize();
    if (sourceSize !== base.length) return null;
    const out = Buffer.allocUnsafe(targetSize);
    let written = 0;
    while (offset < delta.length) {
      const op = delta[offset++]!;
      if (op & 0x80) {
        let copyOffset = 0;
        let copySize = 0;
        let shift = 0;
        for (let bit = 0; bit < 4; bit += 1) {
          if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
          shift += 8;
        }
        shift = 0;
        for (let bit = 4; bit < 7; bit += 1) {
          if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
          shift += 8;
        }
        if (copySize === 0) copySize = 0x10000;
        if (copyOffset + copySize > base.length || written + copySize > targetSize) return null;
        base.copy(out, written, copyOffset, copyOffset + copySize);
        written += copySize;
      } else if (op !== 0) {
        const literal = op & 0x7f;
        if (offset + literal > delta.length || written + literal > targetSize) return null;
        delta.copy(out, written, offset, offset + literal);
        offset += literal;
        written += literal;
      } else {
        return null;
      }
    }
    return written === targetSize ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read a pack into the repository store (thin-pack REF_DELTA bases resolve against the store).
 * Returns the number of objects stored, or -1 when the pack is malformed.
 */
export function readPackInto(repo: Repo, pack: Buffer): number {
  try {
    if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return -1;
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) return -1;
    const count = pack.readUInt32BE(8);
    const trailerStart = pack.length - 20;
    interface Raw {
      offset: number;
      typeCode: number;
      data: Buffer;
      baseOffset?: number;
      baseOid?: string;
    }
    const raw: Raw[] = [];
    const byOffset = new Map<number, Raw>();
    let offset = 12;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = offset;
      let byte = pack[offset++]!;
      const typeCode = (byte >> 4) & 0x07;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
      if (typeCode === 6) {
        let b = pack[offset++]!;
        let value = b & 0x7f;
        while (b & 0x80) {
          b = pack[offset++]!;
          value = (value + 1) * 128 + (b & 0x7f);
        }
        entry.baseOffset = entryOffset - value;
      } else if (typeCode === 7) {
        entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else if (!CODE_TYPE[typeCode]) {
        return -1;
      }
      // Inflate exactly one zlib stream starting at `offset`: feed the rest and count what it used.
      const inflated = inflateWithSize(pack.subarray(0, trailerStart), offset);
      if (inflated === null || inflated.data.length !== size) return -1;
      entry.data = inflated.data;
      offset = inflated.next;
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
    if (offset !== trailerStart) return -1;
    const resolved = new Map<string, GitObject>();
    const resolve = (entry: Raw, guard: Set<number>): GitObject | null => {
      if (entry.typeCode !== 6 && entry.typeCode !== 7) {
        const type = CODE_TYPE[entry.typeCode]!;
        return { type, data: entry.data };
      }
      if (guard.has(entry.offset)) return null;
      guard.add(entry.offset);
      let base: GitObject | null | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        base = baseEntry ? resolve(baseEntry, guard) : null;
      } else {
        base = resolved.get(entry.baseOid!) ?? repo.objects.get(entry.baseOid!) ?? null;
      }
      if (!base) return null;
      const data = applyDelta(base.data, entry.data);
      return data === null ? null : { type: base.type, data };
    };
    let stored = 0;
    for (const entry of raw) {
      const object = resolve(entry, new Set());
      if (!object) return -1;
      const oid = hashObject(object.type, object.data);
      if (!resolved.has(oid)) resolved.set(oid, object);
      storeObject(repo, object.type, object.data);
      stored += 1;
    }
    return stored;
  } catch {
    return -1;
  }
}

/** Inflate the zlib stream at `start`, also reporting where it ended (zlib has no such API, so
 *  the consumed length is found by re-inflating prefixes is too slow — instead inflate with the
 *  `info` engine flag through a small loop over candidate end points is wrong too. The reliable
 *  route: node's zlib returns the engine's bytesRead when asked via inflateSync's info option.) */
function inflateWithSize(buffer: Buffer, start: number): { data: Buffer; next: number } | null {
  try {
    const result = inflateSync(buffer.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const written = result.engine.bytesWritten;
    if (!written || written <= 0) return null;
    return { data: result.buffer, next: start + written };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements and ls-refs
// ---------------------------------------------------------------------------------------------

const AGENT = 'amber-forge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    const emit = (oid: string, name: string): void => {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
    };
    emit(headOid, 'HEAD');
    for (const [name, oid] of refs) {
      emit(oid, name);
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement names no repository state, so its bytes are built once, ever. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function lsRefsReply(repo: Repo, args: LsRefsArgs): Buffer {
  // The reply is a pure function of the ref set and the request's flags; the ref set changes
  // only through touchRefs, so (refsVersion, flags, prefixes) is a sound cache key.
  const cacheKey = `${repo.refsVersion}|${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}|${args.prefixes.join(',')}`;
  if (repo.lsRefsCache !== null && repo.lsRefsCache.key === cacheKey) return repo.lsRefsCache.body;
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  if (keep('HEAD')) {
    if (headOid) parts.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    else parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.lsRefsCache = { key: cacheKey, body };
  return body;
}

// ---------------------------------------------------------------------------------------------
// fetch: object selection (haves, shallow depth) and the sectioned v2 reply
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
}

interface FetchSelection {
  objects: GitObject[];
  boundary: string[];
  unshallow: string[];
}

/**
 * The objects a client already holds, given its haves and its shallow boundary: a shallow
 * client's boundary commits are leaves — their ancestors are NOT held, however reachable
 * they are in the server's graph. (Assuming otherwise is what breaks deepen: the parent
 * beyond the boundary would be treated as already delivered.)
 */
function heldObjects(repo: Repo, haves: readonly string[], shallowLines: readonly string[]): Set<string> {
  const shallow = new Set(shallowLines);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) if (isOid(have)) queue.push(have);
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
        if (!shallow.has(oid)) for (const parent of commit.parents) queue.push(parent);
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

function selectFetchObjects(repo: Repo, args: FetchArgs): FetchSelection {
  const haveObjects = heldObjects(repo, args.haves, args.shallowLines);
  const haveCommits = new Set<string>();
  for (const oid of haveObjects) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') haveCommits.add(oid);
  }
  // Commit distance from the wants (peeling tags): BFS over parents.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !distance.has(commit)) {
      distance.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length) {
    const current = queue.shift()!;
    const depth = distance.get(current)!;
    const view = parseCommitCached(repo, current);
    if (!view) continue;
    for (const parent of view.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  const includedCommits = new Set<string>();
  for (const [oid, depth] of distance) {
    if (haveCommits.has(oid)) continue;
    if (args.depth !== null && depth >= args.depth) continue;
    includedCommits.add(oid);
  }
  const boundary: string[] = [];
  if (args.depth !== null) {
    for (const oid of includedCommits) {
      const view = parseCommitCached(repo, oid);
      if (!view) continue;
      const cut = view.parents.some((parent) => !includedCommits.has(parent) && !haveCommits.has(parent));
      if (cut) boundary.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of args.shallowLines) {
    if (boundary.includes(oid)) continue;
    const view = parseCommitCached(repo, oid);
    if (!view) continue;
    // A boundary commit stops being shallow once one of its parents is delivered in this
    // fetch: the client's history now extends past it.
    const parentDelivered = view.parents.some((parent) => includedCommits.has(parent));
    if (parentDelivered) unshallow.push(oid);
  }
  const chosen = new Set<string>();
  for (const oid of includedCommits) {
    // The commit itself plus its own tree closure — never its ancestors' trees, which the
    // client either has (haves) or must not be sent (beyond the shallow cut).
    chosen.add(oid);
    const view = parseCommitCached(repo, oid);
    if (view) {
      for (const reachable of reachableObjects(repo, [view.tree])) chosen.add(reachable);
    }
  }
  // Tag objects on the want chain are part of the transfer.
  for (const want of args.wants) {
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') break;
      if (!haveObjects.has(current)) chosen.add(current);
      current = parseTag(object.data).object;
    }
  }
  for (const oid of haveObjects) {
    const object = repo.objects.get(oid);
    if (object && object.type !== 'commit') chosen.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of chosen) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, boundary, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const chunkSize = 32768;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

function v2FetchReply(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = [
    repo.id,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallowLines].sort().join(','),
    args.depth ?? '',
  ].join('|');
  const cached = forge.fetchCache.get(cacheKey);
  if (cached) return cached;
  const selection = selectFetchObjects(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acks = args.haves.filter((have) => repo.objects.has(have));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of new Set(acks)) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(PKT_DELIM);
  }
  if (selection.boundary.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  const reply = Buffer.concat(parts);
  if (forge.fetchCache.size < 128) forge.fetchCache.set(cacheKey, reply);
  return reply;
}

function v0FetchReply(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  void forge;
  const reader = pktReader(body);
  if (reader === null) return Buffer.alloc(0);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet === 'flush') break;
    if (packet === 'delim') continue;
    let line = (packet as Buffer).toString('utf8').replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  const pack = reader.rest();
  let unpackOk = true;
  if (pack.length > 0) {
    if (readPackInto(repo, pack) < 0) unpackOk = false;
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    if (!command.ref.startsWith('refs/')) {
      reportLines.push(`ng ${command.ref} invalid ref\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      touchRefs(repo);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} unresolved object\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (current !== undefined && current !== command.newOid) {
      const currentCommit = peelToCommit(repo, current);
      const newCommit = peelToCommit(repo, command.newOid);
      if (currentCommit !== null && newCommit !== null && !isAncestor(repo, currentCommit, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    touchRefs(repo);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    // The report-status stream rides inside band-1 packets, themselves pkt-framed.
    const packets: Buffer[] = [];
    const chunkSize = 32768;
    for (let offset = 0; offset < report.length; offset += chunkSize) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + chunkSize));
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    packets.push(PKT_FLUSH);
    return Buffer.concat(packets);
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// the HTTP entry point: /{owner}/{repo}.git/...
// ---------------------------------------------------------------------------------------------

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && /(^|[,;])\s*version=2\b/.test(header);
}

export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && sub === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    if (service === 'git-upload-pack' && wantsV2(req)) {
      sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendBytes(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
    return;
  }
  if (method === 'POST' && sub === 'git-upload-pack') {
    const reader = pktReader(body);
    if (reader === null) {
      sendBytes(res, 400, Buffer.from('invalid pkt-line\n'), 'text/plain; charset=utf-8');
      return;
    }
    const lines: string[] = [];
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet === 'flush') break;
      if (packet === 'delim') {
        lines.push('\u0001');
        continue;
      }
      lines.push((packet as Buffer).toString('utf8').replace(/\n$/, ''));
    }
    const command = lines.find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
      for (const line of lines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      sendBytes(res, 200, lsRefsReply(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null };
      for (const line of lines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
      }
      args.wants = args.wants.filter(isOid);
      args.haves = args.haves.filter(isOid);
      const reply = wantsV2(req) ? v2FetchReply(forge, repo, args) : v0FetchReply(repo, args);
      sendBytes(res, 200, reply, 'application/x-git-upload-pack-result');
      return;
    }
    sendBytes(res, 400, Buffer.from('unsupported command\n'), 'text/plain; charset=utf-8');
    return;
  }
  if (method === 'POST' && sub === 'git-receive-pack') {
    sendBytes(res, 200, receivePack(forge, repo, body), 'application/x-git-receive-pack-result');
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}
