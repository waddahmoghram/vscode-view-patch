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
import { PatchMetadata, splitPatchMessages } from './patchText';

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
    const maxContentBytes = positiveLimit('maxContentBytes', controls.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES);
    const maxOutputBytes = positiveLimit('maxOutputBytes', controls.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const timeoutMs = positiveLimit('timeoutMs', controls.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (patch.byteLength > maxPatchBytes) {
        throw new OperationLimitError(`Patch exceeds the ${maxPatchBytes}-byte patch limit.`);
    }
    if (base.startsWith('-')) {
        throw new Error(`"${base}" is not a revision.`);
    }
    const deadline = Date.now() + timeoutMs;
    const optionsFor = (env?: Readonly<Record<string, string>>): GitOptions => {
        throwIfAborted(controls.signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new OperationTimeoutError(timeoutMs);
        }
        return { ...controls, cwd: repo, env, timeoutMs: remaining, maxOutputBytes };
    };
    const messages = splitPatchMessages(patch);
    const applicable = messages.filter(message => message.hasDiff);
    if (applicable.length === 0) {
        throw new Error('The patch contains no file differences to apply.');
    }
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
        const treeId = async (args: readonly string[], input?: string, privateOnly = false): Promise<string> => {
            const id = (await (privateOnly ? write : run)(args, input)).toString('utf8').trim();
            if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) {
                throw new Error('Git returned an invalid tree object identifier.');
            }
            return id;
        };
        // A root patch's empty tree need not exist in the source object database.
        await treeId(['hash-object', '-w', '-t', 'tree', '--stdin'], '', true);
        const baseTree = await treeId(['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`]);
        await run(['read-tree', baseTree]);
        const blobs = new BlobStore(run, maxContentBytes);
        const readDifference = async (before: string, after: string): Promise<AppliedPatch> => {
            const raw = await run(['diff-tree', '--no-commit-id', '-r', '-M', '--raw', '--no-abbrev', '-z',
                before, after, '--']);
            return readChanges(parseRawDiff(raw), blobs);
        };
        const parts: AppliedPatchPart[] = [];
        let previousTree = baseTree;
        for (const [index, message] of applicable.entries()) {
            try {
                const preimages = await preimageIds(run, message.bytes);
                await blobs.load(preimages);
                await blobs.materialize(preimages, path.join(scratch, 'objects'), () => { optionsFor(); });
                await write(['apply', '--cached', '--whitespace=nowarn', '-'], message.bytes);
                const nextTree = await treeId(['write-tree', '--missing-ok'], undefined, true);
                const difference = await readDifference(previousTree, nextTree);
                parts.push({ metadata: reviewMetadata(message.metadata), ...difference });
                previousTree = nextTree;
            } catch (error) {
                if (error instanceof GitError) {
                    const subject = message.metadata.subject;
                    const label = subject ? ` (${subject.slice(0, 200)})` : '';
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
        const cumulative = parts.length === 1 ? parts[0] : await readDifference(baseTree, previousTree);
        optionsFor();
        return {
            changes: cumulative.changes,
            skipped: cumulative.skipped,
            parts,
            metadata: reviewMetadata(messages[0]?.metadata ?? {}),
            baseTree,
        };
    } catch (error) {
        if (error instanceof OperationTimeoutError) {
            throw new OperationTimeoutError(timeoutMs);
        }
        throw error;
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

function identity(change: RawChange): Pick<RawChange, 'oldId' | 'newId' | 'oldMode' | 'newMode'> {
    return {
        oldId: change.oldId,
        newId: change.newId,
        oldMode: change.oldMode,
        newMode: change.newMode,
    };
}

async function readChanges(raw: readonly RawChange[], blobs: BlobStore): Promise<AppliedPatch> {
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
