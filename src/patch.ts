import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { deflate } from 'zlib';
import { Git, GitError, GitOptions } from './git';
import {
    DEFAULT_MAX_CONTENT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_PATCH_BYTES,
    DEFAULT_TIMEOUT_MS,
    OperationLimitError,
    OperationOptions,
    OperationTimeoutError,
    positiveLimit,
    throwIfAborted,
} from './operations';
import { PatchMessage, PatchMetadata, splitPatchMessages } from './patchText';

/** How Git classified a changed file: added, copied, deleted, modified, renamed, or type changed. */
export type ChangeStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T';

/** A file whose content the patch changes, with its bytes before and after. An added or deleted side is absent. */
export interface FileChange {
    readonly status: ChangeStatus;
    readonly oldPath: string;
    readonly newPath: string;
    readonly before?: Buffer;
    readonly after?: Buffer;
    readonly oldId?: string;
    readonly newId?: string;
    readonly oldMode?: string;
    readonly newMode?: string;
}

/** Why a changed file has no content difference to show. */
export type SkipReason = 'submodule' | 'mode' | 'rename';

export interface SkippedChange {
    readonly reason: SkipReason;
    readonly oldPath: string;
    readonly newPath: string;
    readonly oldId?: string;
    readonly newId?: string;
    readonly oldMode?: string;
    readonly newMode?: string;
}

export interface AppliedPatchPart {
    readonly metadata: PatchMetadata;
    readonly changes: readonly FileChange[];
    readonly skipped: readonly SkippedChange[];
}

export interface AppliedPatch {
    readonly changes: readonly FileChange[];
    readonly skipped: readonly SkippedChange[];
    readonly parts?: readonly AppliedPatchPart[];
    readonly metadata?: PatchMetadata;
    readonly baseTree?: string;
    /** The tree the patch produced; equals the base tree when the patch changed nothing. */
    readonly resultTree: string;
}

/** Two versions of a patch applied on the same frozen base, and the difference between their results. */
export interface PatchComparison {
    readonly base: string;
    readonly baseTree: string;
    readonly first: AppliedPatch;
    readonly second: AppliedPatch;
    readonly changes: readonly FileChange[];
    readonly skipped: readonly SkippedChange[];
}

/** What a merge commit changed against each of its parents, in parent order. */
export interface MergeChanges {
    readonly commit: string;
    readonly parents: readonly string[];
    readonly perParent: readonly {
        readonly parent: string;
        readonly changes: readonly FileChange[];
        readonly skipped: readonly SkippedChange[];
    }[];
}

/** One record of Git's `--raw -z` diff output. */
export interface RawChange {
    readonly oldMode: string;
    readonly newMode: string;
    readonly oldId: string;
    readonly newId: string;
    readonly status: string;
    readonly oldPath: string;
    readonly newPath: string;
}

const SUBMODULE_MODE = '160000';
const compress = promisify(deflate);
const SCRATCH_CONFIG = [
    '-c', 'core.splitIndex=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'core.sparseCheckout=false',
    '-c', 'index.sparse=false',
];

/** The commit named on the first line of a `git format-patch` or `git show` file, if there is one. */
export function patchCommit(patch: string): string | undefined {
    if (!/^(?:From |commit )/.test(patch)) {
        return undefined;
    }
    return reviewMetadata(splitPatchMessages(Buffer.from(patch))[0]?.metadata ?? {}).commit;
}

function reviewMetadata(metadata: PatchMetadata): PatchMetadata {
    return metadata.index === 0 || /^0+$/.test(metadata.commit ?? '')
        ? { ...metadata, commit: undefined }
        : metadata;
}

/** True when the text has a file header that Git can apply: `diff --git`, or a `---` line followed by `+++`. */
export function looksLikePatch(patch: string): boolean {
    return splitPatchMessages(Buffer.from(patch)).some(message => message.hasDiff);
}

/** True when Git would treat the bytes as binary: a NUL byte within the first 8000 bytes. */
export function isBinary(content: Uint8Array): boolean {
    return content.subarray(0, 8000).includes(0);
}

/** Parses Git's `--raw -z` diff output. */
export function parseRawDiff(raw: Buffer): RawChange[] {
    const fields = raw.toString('utf8').split('\0');
    const changes: RawChange[] = [];
    let i = 0;
    while (i < fields.length && fields[i] !== '') {
        const header = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRT](?:\d{1,3})?)$/
            .exec(fields[i++]);
        if (!header) {
            throw new Error('Git returned a malformed raw diff header.');
        }
        const [, oldMode, newMode, oldId, newId, status] = header;
        const oldPath = fields[i++];
        const newPath = /^[RC]/.test(status) ? fields[i++] : oldPath;
        if (!oldPath || !newPath || i >= fields.length) {
            throw new Error('Git returned a truncated raw diff record.');
        }
        changes.push({ oldMode, newMode, oldId, newId, status, oldPath, newPath });
    }
    if (i !== fields.length - 1) {
        throw new Error('Git returned unexpected data after its raw diff.');
    }
    return changes;
}

/** Content and skip records between two trees. */
interface ChangeSet {
    readonly changes: readonly FileChange[];
    readonly skipped: readonly SkippedChange[];
}

interface SessionLimits {
    readonly maxContentBytes: number;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
}

function sessionLimits(controls: OperationOptions): SessionLimits {
    return {
        maxContentBytes: positiveLimit('maxContentBytes', controls.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES),
        maxOutputBytes: positiveLimit('maxOutputBytes', controls.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
        timeoutMs: positiveLimit('timeoutMs', controls.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
}

/** Private scratch state shared by the commands of one operation: one index, one object folder, one budget. */
interface ScratchSession {
    readonly scratch: string;
    readonly run: RunGit;
    readonly write: RunGit;
    readonly objectId: (args: readonly string[], input?: string, privateOnly?: boolean) => Promise<string>;
    readonly blobs: BlobStore;
    readonly readDifference: (before: string, after: string) => Promise<ChangeSet>;
    readonly check: () => void;
}

/**
 * Runs `action` with a private scratch index and object folder beside the repository's objects.
 *
 * Read commands borrow source objects; object writers see only private objects to avoid freshening source timestamps.
 * The repository's index, working tree, references, and objects are never written. All exits remove the scratch folder.
 */
async function withScratchSession<T>(
    git: Git,
    repo: string,
    controls: OperationOptions,
    limits: SessionLimits,
    action: (session: ScratchSession) => Promise<T>,
): Promise<T> {
    const deadline = Date.now() + limits.timeoutMs;
    const optionsFor = (env?: Readonly<Record<string, string>>): GitOptions => {
        throwIfAborted(controls.signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new OperationTimeoutError(limits.timeoutMs);
        }
        return { ...controls, cwd: repo, env, timeoutMs: remaining, maxOutputBytes: limits.maxOutputBytes };
    };
    const objects = path.resolve(repo, await git.text(['rev-parse', '--git-path', 'objects'], optionsFor()));
    optionsFor();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'view-patch-'));
    try {
        optionsFor();
        await fs.mkdir(path.join(scratch, 'objects'));
        const env = {
            GIT_INDEX_FILE: path.join(scratch, 'index'),
            GIT_OBJECT_DIRECTORY: path.join(scratch, 'objects'),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_LITERAL_PATHSPECS: '1',
        };
        const run = (args: readonly string[], input?: string | Uint8Array): Promise<Buffer> =>
            git.run([...SCRATCH_CONFIG, ...args], { ...optionsFor(env), input });
        const write = (args: readonly string[], input?: string | Uint8Array): Promise<Buffer> =>
            git.run([...SCRATCH_CONFIG, ...args], {
                ...optionsFor({ ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: '' }), input,
            });
        const objectId = async (args: readonly string[], input?: string, privateOnly = false): Promise<string> => {
            const id = (await (privateOnly ? write : run)(args, input)).toString('utf8').trim();
            if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) {
                throw new Error('Git returned an invalid object identifier.');
            }
            return id;
        };
        const blobs = new BlobStore(run, limits.maxContentBytes);
        const readDifference = async (before: string, after: string): Promise<ChangeSet> => {
            const raw = await run(['diff-tree', '--no-commit-id', '-r', '-M', '--raw', '--no-abbrev', '-z',
                before, after, '--']);
            return readChanges(parseRawDiff(raw), blobs);
        };
        const check = (): void => { optionsFor(); };
        return await action({ scratch, run, write, objectId, blobs, readDifference, check });
    } catch (error) {
        if (error instanceof OperationTimeoutError) {
            throw new OperationTimeoutError(limits.timeoutMs);
        }
        throw error;
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

/** Resolves `base` to a frozen tree and loads it into the private index. */
async function freezeBase(session: ScratchSession, base: string): Promise<string> {
    // A root patch's empty tree need not exist in the source object database.
    await session.objectId(['hash-object', '-w', '-t', 'tree', '--stdin'], '', true);
    const baseTree = await session.objectId(['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`]);
    await session.run(['read-tree', baseTree]);
    return baseTree;
}

interface SequenceResult extends ChangeSet {
    readonly parts: readonly AppliedPatchPart[];
    readonly resultTree: string;
}

/** Applies diff-bearing messages sequentially on the tree already read into the session index. */
async function applyMessages(
    session: ScratchSession,
    applicable: readonly PatchMessage[],
    baseTree: string,
): Promise<SequenceResult> {
    const parts: AppliedPatchPart[] = [];
    let previousTree = baseTree;
    for (const [index, message] of applicable.entries()) {
        const subject = message.metadata.subject;
        const label = subject ? ` (${subject.slice(0, 200)})` : '';
        // Surface transfer-encoding problems by name instead of letting git apply fail on undecoded bytes.
        if (message.encodingError) {
            throw new Error(
                `Patch ${index + 1}/${applicable.length}${label} cannot be decoded: ${message.encodingError}`,
            );
        }
        const content = message.decodedBytes ?? message.bytes;
        try {
            const preimages = await preimageIds(session.run, content);
            await session.blobs.load(preimages);
            await session.blobs.materialize(preimages, path.join(session.scratch, 'objects'), session.check);
            await session.write(['apply', '--cached', '--whitespace=nowarn', '-'], content);
            const nextTree = await session.objectId(['write-tree', '--missing-ok'], undefined, true);
            const difference = await session.readDifference(previousTree, nextTree);
            parts.push({ metadata: reviewMetadata(message.metadata), ...difference });
            previousTree = nextTree;
        } catch (error) {
            if (error instanceof GitError) {
                const failure = new GitError(
                    `Patch ${index + 1}/${applicable.length}${label} failed: ${error.message}`,
                    error.args,
                    error.exitCode,
                );
                failure.cause = error;
                throw failure;
            }
            throw error;
        }
    }
    const cumulative = parts.length === 1 ? parts[0] : await session.readDifference(baseTree, previousTree);
    return { changes: cumulative.changes, skipped: cumulative.skipped, parts, resultTree: previousTree };
}

/**
 * Applies diff-bearing messages sequentially on `base`, returning per-message and cumulative content snapshots.
 *
 * Read commands borrow source objects; object writers see only private objects to avoid freshening source timestamps.
 * The repository's index, working tree, references, and objects are never written. All exits remove the scratch folder.
 */
export async function applyPatch(
    git: Git,
    repo: string,
    base: string,
    patch: Uint8Array,
    controls: OperationOptions = {},
): Promise<AppliedPatch> {
    throwIfAborted(controls.signal);
    const maxPatchBytes = positiveLimit('maxPatchBytes', controls.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);
    const limits = sessionLimits(controls);
    if (patch.byteLength > maxPatchBytes) {
        throw new OperationLimitError(`Patch exceeds the ${maxPatchBytes}-byte patch limit.`);
    }
    if (base.startsWith('-')) {
        throw new Error(`"${base}" is not a revision.`);
    }
    const messages = splitPatchMessages(patch);
    const applicable = messages.filter(message => message.hasDiff);
    if (applicable.length === 0) {
        throw new Error('The patch contains no file differences to apply.');
    }
    return withScratchSession(git, repo, controls, limits, async session => {
        const baseTree = await freezeBase(session, base);
        const applied = await applyMessages(session, applicable, baseTree);
        session.check();
        return {
            changes: applied.changes,
            skipped: applied.skipped,
            parts: applied.parts,
            metadata: reviewMetadata(messages[0]?.metadata ?? {}),
            baseTree,
            resultTree: applied.resultTree,
        };
    });
}

/**
 * Applies `first` and `second` on the same frozen `base` in one scratch session and compares their results.
 *
 * Both applications and the comparison share one deadline and one content budget. A Git failure while a version
 * applies is labelled `First patch:` or `Second patch:` so callers can say which one failed.
 */
export async function compareApplied(
    git: Git,
    repo: string,
    base: string,
    first: Uint8Array,
    second: Uint8Array,
    options: OperationOptions = {},
): Promise<PatchComparison> {
    throwIfAborted(options.signal);
    const maxPatchBytes = positiveLimit('maxPatchBytes', options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);
    const limits = sessionLimits(options);
    if (base.startsWith('-')) {
        throw new Error(`"${base}" is not a revision.`);
    }
    const prepare = (name: 'first' | 'second', patch: Uint8Array): readonly PatchMessage[] => {
        if (patch.byteLength > maxPatchBytes) {
            throw new OperationLimitError(`The ${name} patch exceeds the ${maxPatchBytes}-byte patch limit.`);
        }
        const messages = splitPatchMessages(patch);
        if (!messages.some(message => message.hasDiff)) {
            throw new Error(`The ${name} patch contains no file differences to apply.`);
        }
        return messages;
    };
    const firstMessages = prepare('first', first);
    const secondMessages = prepare('second', second);
    return withScratchSession(git, repo, options, limits, async session => {
        const baseTree = await freezeBase(session, base);
        const applyVersion = async (label: string, messages: readonly PatchMessage[]): Promise<AppliedPatch> => {
            try {
                const applied = await applyMessages(session, messages.filter(message => message.hasDiff), baseTree);
                return {
                    changes: applied.changes,
                    skipped: applied.skipped,
                    parts: applied.parts,
                    metadata: reviewMetadata(messages[0]?.metadata ?? {}),
                    baseTree,
                    resultTree: applied.resultTree,
                };
            } catch (error) {
                if (error instanceof GitError) {
                    const failure = new GitError(`${label}: ${error.message}`, error.args, error.exitCode);
                    failure.cause = error;
                    throw failure;
                }
                throw error;
            }
        };
        const firstApplied = await applyVersion('First patch', firstMessages);
        // The second version starts from the same frozen base, not from the first version's result.
        await session.run(['read-tree', baseTree]);
        const secondApplied = await applyVersion('Second patch', secondMessages);
        const between = await session.readDifference(firstApplied.resultTree, secondApplied.resultTree);
        session.check();
        return {
            base,
            baseTree,
            first: firstApplied,
            second: secondApplied,
            changes: between.changes,
            skipped: between.skipped,
        };
    });
}

/**
 * The changes a commit introduces against each of its parents, in parent order, with blob contents loaded.
 *
 * Every tree involved already exists in the source repository, so nothing is ever written: every command reads
 * through the private scratch environment with the source objects borrowed as alternates, and the private empty
 * tree is never needed because each compared side belongs to an existing commit.
 */
export async function mergeChanges(
    git: Git,
    repo: string,
    commit: string,
    options: OperationOptions = {},
): Promise<MergeChanges> {
    throwIfAborted(options.signal);
    const limits = sessionLimits(options);
    if (commit === '' || commit.startsWith('-')) {
        throw new Error('The commit must be a nonempty revision, not a Git option.');
    }
    return withScratchSession(git, repo, options, limits, async session => {
        const id = await session.objectId(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]);
        // Plain rev-parse echoes --end-of-options; the id is already a verified full hash, so none is needed.
        const listed = (await session.run(['rev-parse', `${id}^@`])).toString('utf8');
        const parents = listed.split('\n').filter(line => line !== '');
        for (const parent of parents) {
            if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent)) {
                throw new Error('Git returned an invalid parent commit identifier.');
            }
        }
        const commitTree = await session.objectId(['rev-parse', '--verify', '--end-of-options', `${id}^{tree}`]);
        const perParent: { parent: string; changes: readonly FileChange[]; skipped: readonly SkippedChange[] }[] = [];
        for (const parent of parents) {
            const parentTree = await session.objectId(['rev-parse', '--verify', '--end-of-options',
                `${parent}^{tree}`]);
            const difference = await session.readDifference(parentTree, commitTree);
            perParent.push({ parent, ...difference });
        }
        session.check();
        return { commit: id, parents, perParent };
    });
}

function identity(change: RawChange): Pick<RawChange, 'oldId' | 'newId' | 'oldMode' | 'newMode'> {
    return {
        oldId: change.oldId,
        newId: change.newId,
        oldMode: change.oldMode,
        newMode: change.newMode,
    };
}

async function readChanges(raw: readonly RawChange[], blobs: BlobStore): Promise<ChangeSet> {
    const shown: RawChange[] = [];
    const skipped: SkippedChange[] = [];
    for (const change of raw) {
        const reason = skipReason(change);
        if (reason) {
            skipped.push({ reason, oldPath: change.oldPath, newPath: change.newPath, ...identity(change) });
        } else {
            shown.push(change);
        }
    }

    const ids = new Set<string>();
    for (const change of shown) {
        if (!change.status.startsWith('A')) {
            ids.add(change.oldId);
        }
        if (!change.status.startsWith('D')) {
            ids.add(change.newId);
        }
    }
    await blobs.load([...ids]);

    const changes = shown.map((change): FileChange => ({
        status: change.status[0] as ChangeStatus,
        oldPath: change.oldPath,
        newPath: change.newPath,
        before: change.status.startsWith('A') ? undefined : blobs.get(change.oldId),
        after: change.status.startsWith('D') ? undefined : blobs.get(change.newId),
        ...identity(change),
    }));
    return { changes, skipped };
}

function skipReason(change: RawChange): SkipReason | undefined {
    if (change.oldMode === SUBMODULE_MODE || change.newMode === SUBMODULE_MODE) {
        return 'submodule';
    }
    if (change.oldId !== change.newId || /^[AD]/.test(change.status)) {
        return undefined;
    }
    return /^[RC]/.test(change.status) ? 'rename' : 'mode';
}

type RunGit = (args: readonly string[], input?: string | Uint8Array) => Promise<Buffer>;

async function preimageIds(run: RunGit, patch: Uint8Array): Promise<readonly string[]> {
    const stats = await run(['apply', '--numstat', '--reverse', '-z', '-'], patch);
    const records = zeroTerminated(stats, 'patch statistics');
    const paths = new Set(records.map(record => {
        const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(record);
        if (!match) {
            throw new Error('Git returned malformed patch statistics.');
        }
        return match[1];
    }));
    const ids = new Set<string>();
    const collect = async (names: readonly string[]): Promise<void> => {
        const output = await run(['ls-files', '--stage', '-z', '--', ...names]);
        for (const record of zeroTerminated(output, 'index entries')) {
            const header = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/.exec(record);
            if (!header) {
                throw new Error('Git returned a malformed index entry.');
            }
            if (header[1] !== SUBMODULE_MODE) {
                ids.add(header[2]);
            }
        }
    };
    let batch: string[] = [];
    let bytes = 0;
    for (const name of paths) {
        const size = Buffer.byteLength(name) + 1;
        if (batch.length > 0 && bytes + size > 16 * 1024) {
            await collect(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(name);
        bytes += size;
    }
    if (batch.length > 0) {
        await collect(batch);
    }
    return [...ids];
}

function zeroTerminated(output: Buffer, description: string): string[] {
    if (output.length === 0) {
        return [];
    }
    const records = output.toString('utf8').split('\0');
    if (records.pop() !== '') {
        throw new Error(`Git returned truncated ${description}.`);
    }
    return records;
}

class BlobStore {
    private readonly blobs = new Map<string, Buffer>();
    private readonly materialized = new Set<string>();
    private loadedBytes = 0;

    constructor(private readonly run: RunGit, private readonly maxBytes: number) {}

    get(id: string): Buffer {
        const blob = this.blobs.get(id);
        if (blob === undefined) {
            throw new Error(`Git did not return blob ${id}.`);
        }
        return blob;
    }

    async materialize(ids: readonly string[], directory: string, check: () => void): Promise<void> {
        // Git freshens existing alternate objects on writes, so writers must use private objects only.
        for (const id of ids) {
            check();
            if (this.materialized.has(id)) {
                continue;
            }
            const blob = this.get(id);
            const content = Buffer.concat([Buffer.from(`blob ${blob.length}\0`), blob]);
            const compressed = await compress(content);
            check();
            const folder = path.join(directory, id.slice(0, 2));
            await fs.mkdir(folder, { recursive: true });
            try {
                await fs.writeFile(path.join(folder, id.slice(2)), compressed, { flag: 'wx' });
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
                    throw error;
                }
            }
            this.materialized.add(id);
        }
    }

    async load(ids: readonly string[]): Promise<void> {
        const missing = [...new Set(ids)].filter(id => !this.blobs.has(id));
        if (missing.length === 0) {
            return;
        }
        const input = missing.map(id => `${id}\n`).join('');
        const checks = await this.run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], input);
        const sizes: number[] = [];
        let offset = 0;
        let total = this.loadedBytes;
        for (const id of missing) {
            const header = readBlobHeader(checks, offset, id);
            if (header.size > this.maxBytes - total) {
                throw new OperationLimitError(`File contents exceed the ${this.maxBytes}-byte content limit.`);
            }
            total += header.size;
            sizes.push(header.size);
            offset = header.end;
        }
        if (offset !== checks.length) {
            throw new Error('Git returned unexpected data after its object size headers.');
        }
        const output = await this.run(['cat-file', '--batch'], input);
        offset = 0;
        for (const [index, id] of missing.entries()) {
            const header = readBlobHeader(output, offset, id);
            if (header.size !== sizes[index]) {
                throw new Error(`Git returned an inconsistent size for blob ${id}.`);
            }
            const end = header.end + header.size;
            if (end >= output.length || output[end] !== 0x0a) {
                throw new Error(`Git returned a truncated body or missing terminator for blob ${id}.`);
            }
            const blob = Buffer.from(output.subarray(header.end, end));
            const hash = createHash(id.length === 64 ? 'sha256' : 'sha1')
                .update(`blob ${blob.length}\0`).update(blob).digest('hex');
            if (hash !== id) {
                throw new Error(`Git returned content that does not match blob ${id}.`);
            }
            this.blobs.set(id, blob);
            offset = end + 1;
        }
        if (offset !== output.length) {
            throw new Error('Git returned unexpected data after its blob bodies.');
        }
        this.loadedBytes = total;
    }
}

function readBlobHeader(output: Buffer, offset: number, id: string): { size: number; end: number } {
    const end = output.indexOf(0x0a, offset);
    if (end < 0) {
        throw new Error(`Git returned a missing or truncated header for blob ${id}.`);
    }
    const header = output.toString('utf8', offset, end);
    if (header === `${id} missing`) {
        throw new Error(`Git could not read missing object ${id}.`);
    }
    const fields = header.split(' ');
    if (fields.length !== 3 || fields[0] !== id || fields[1] !== 'blob' || !/^(?:0|[1-9]\d*)$/.test(fields[2])) {
        throw new Error(`Git returned a malformed blob header for ${id}.`);
    }
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size)) {
        throw new Error(`Git returned an invalid blob size for ${id}.`);
    }
    return { size, end: end + 1 };
}
