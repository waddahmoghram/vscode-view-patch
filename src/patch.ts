import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Git, GitOptions } from './git';

/** How Git classified a changed file: added, copied, deleted, modified, renamed, or type changed. */
export type ChangeStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T';

/** A file whose content the patch changes, with its bytes before and after. An added or deleted side is absent. */
export interface FileChange {
    readonly status: ChangeStatus;
    readonly oldPath: string;
    readonly newPath: string;
    readonly before?: Buffer;
    readonly after?: Buffer;
}

/** Why a changed file has no content difference to show. */
export type SkipReason = 'submodule' | 'mode' | 'rename';

export interface SkippedChange {
    readonly reason: SkipReason;
    readonly oldPath: string;
    readonly newPath: string;
}

export interface AppliedPatch {
    readonly changes: readonly FileChange[];
    readonly skipped: readonly SkippedChange[];
}

/** One record of `git diff-index --raw -z` output. */
export interface RawChange {
    readonly oldMode: string;
    readonly newMode: string;
    readonly oldId: string;
    readonly newId: string;
    readonly status: string;
    readonly oldPath: string;
    readonly newPath: string;
}

const COMMIT_LINE = /^(?:From|commit) ([0-9a-f]{7,64})(?:\s|$)/;
const SUBMODULE_MODE = '160000';

/** The commit named on the first line of a `git format-patch` or `git show` file, if there is one. */
export function patchCommit(patch: string): string | undefined {
    return COMMIT_LINE.exec(patch.split('\n', 1)[0])?.[1];
}

/** True when the text has a file header that Git can apply: `diff --git`, or a `---` line followed by `+++`. */
export function looksLikePatch(patch: string): boolean {
    return /^diff --git /m.test(patch) || /^--- .*\r?\n\+\+\+ /m.test(patch);
}

/** True when Git would treat the bytes as binary: a NUL byte within the first 8000 bytes. */
export function isBinary(content: Uint8Array): boolean {
    return content.subarray(0, 8000).includes(0);
}

/** Parses `git diff-index --raw -z` output. */
export function parseRawDiff(raw: Buffer): RawChange[] {
    const fields = raw.toString('utf8').split('\0');
    const changes: RawChange[] = [];
    let i = 0;
    while (i < fields.length && fields[i] !== '') {
        const [oldMode, newMode, oldId, newId, status] = fields[i++].replace(/^:/, '').split(' ');
        const oldPath = fields[i++];
        const newPath = /^[RC]/.test(status) ? fields[i++] : oldPath;
        changes.push({ oldMode, newMode, oldId, newId, status, oldPath, newPath });
    }
    return changes;
}

/**
 * Applies `patch` on `base` in the repository at `repo` and reads each changed file on both sides.
 *
 * Git works in a scratch index and object folder that borrow the repository's objects, so the repository's index,
 * working tree, references, and object database are never written. The scratch folder is deleted before returning.
 */
export async function applyPatch(git: Git, repo: string, base: string, patch: Uint8Array): Promise<AppliedPatch> {
    if (base.startsWith('-')) {
        throw new Error(`"${base}" is not a revision.`);
    }
    const objects = path.resolve(repo, await git.text(['rev-parse', '--git-path', 'objects'], { cwd: repo }));
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'view-patch-'));
    try {
        await fs.mkdir(path.join(scratch, 'objects'));
        const options: GitOptions = {
            cwd: repo,
            env: {
                GIT_INDEX_FILE: path.join(scratch, 'index'),
                GIT_OBJECT_DIRECTORY: path.join(scratch, 'objects'),
                GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
            },
        };
        await git.run(['read-tree', base], options);
        await git.run(['apply', '--cached', '--whitespace=nowarn', '-'], { ...options, input: patch });
        const raw = await git.run(['diff-index', '--cached', '-M', '--raw', '-z', base], options);
        return await readChanges(git, parseRawDiff(raw), options);
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

async function readChanges(git: Git, raw: readonly RawChange[], options: GitOptions): Promise<AppliedPatch> {
    const shown: RawChange[] = [];
    const skipped: SkippedChange[] = [];
    for (const change of raw) {
        const reason = skipReason(change);
        if (reason) {
            skipped.push({ reason, oldPath: change.oldPath, newPath: change.newPath });
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
    const blobs = await readBlobs(git, [...ids], options);

    const changes = shown.map((change): FileChange => ({
        status: change.status[0] as ChangeStatus,
        oldPath: change.oldPath,
        newPath: change.newPath,
        before: change.status.startsWith('A') ? undefined : blobs.get(change.oldId),
        after: change.status.startsWith('D') ? undefined : blobs.get(change.newId),
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

// One `git cat-file --batch` reads every blob: each answer is "<id> <type> <size>\n<content>\n".
async function readBlobs(git: Git, ids: readonly string[], options: GitOptions): Promise<Map<string, Buffer>> {
    const blobs = new Map<string, Buffer>();
    if (ids.length === 0) {
        return blobs;
    }
    const output = await git.run(['cat-file', '--batch'], { ...options, input: ids.map(id => `${id}\n`).join('') });
    let offset = 0;
    for (const id of ids) {
        const end = output.indexOf(0x0a, offset);
        const header = end < 0 ? [] : output.toString('utf8', offset, end).split(' ');
        if (header.length !== 3) {
            throw new Error(`Git could not read object ${id}.`);
        }
        const start = end + 1;
        const size = Number(header[2]);
        blobs.set(id, Buffer.from(output.subarray(start, start + size)));
        offset = start + size + 1;
    }
    return blobs;
}
