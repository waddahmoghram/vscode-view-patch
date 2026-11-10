import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Git, GitError, GitOptions } from './git';
import {
    DEFAULT_TIMEOUT_MS,
    OperationLimitError,
    OperationOptions,
    OperationTimeoutError,
    positiveLimit,
    throwIfAborted,
} from './operations';
import { AppliedPatch, applyPatch } from './patch';
import { splitPatchMessages } from './patchText';

/** Where a patch applied, and what it changed there. */
export interface PatchTarget {
    readonly repo: string;
    readonly base: string;
    readonly applied: AppliedPatch;
}

/** A repository and base where the patch did not apply, with Git's reason. */
export interface FailedAttempt {
    readonly repo: string;
    readonly base: string;
    readonly reason: string;
}

export interface Resolution {
    /** Where the patch applied, in candidate order. */
    readonly targets: readonly PatchTarget[];
    /** Where it did not. */
    readonly failures: readonly FailedAttempt[];
    /** The candidate repository that has the commit the patch names, when there is one. */
    readonly commitRepo?: string;
    /**
     * Repositories whose HEAD content already contains the change, in candidate order.
     *
     * Present only when nothing applied forward and at least one repository's HEAD reverse-applies the patch
     * cleanly. Each revision is the symbolic head plus its resolved short hash, such as `HEAD (abc1234)`.
     */
    readonly alreadyApplied?: readonly { repo: string; revision: string }[];
}

/** The top folder of the Git working tree that contains `folder`, or undefined when there is none. */
export async function topLevel(
    git: Git,
    folder: string,
    options: OperationOptions = {},
): Promise<string | undefined> {
    throwIfAborted(options.signal);
    try {
        const stat = await fs.stat(folder);
        throwIfAborted(options.signal);
        if (!stat.isDirectory()) {
            return undefined;
        }
    } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            return undefined;
        }
        throw error;
    }
    try {
        const top = await git.text(['rev-parse', '--show-toplevel'], {
            ...options,
            cwd: folder,
            env: { LC_ALL: 'C' },
        });
        throwIfAborted(options.signal);
        return top ? path.normalize(top) : undefined;
    } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof GitError && error.exitCode === 128 && (
            /^fatal: not a git repository(?:[ (:]|$)/.test(error.message)
            || error.message === 'fatal: this operation must be run in a work tree'
        )) {
            return undefined;
        }
        throw error;
    }
}

/** The repositories that hold `folders`, in order and without repeats. Folders outside Git are left out. */
export async function findRepositories(
    git: Git,
    folders: readonly string[],
    options: OperationOptions = {},
): Promise<string[]> {
    throwIfAborted(options.signal);
    const seen = new Set<string>();
    const repos: string[] = [];
    for (const folder of folders) {
        throwIfAborted(options.signal);
        const top = await topLevel(git, folder, options);
        const key = top && (process.platform === 'win32' ? top.toLowerCase() : top);
        if (top && key && !seen.has(key)) {
            seen.add(key);
            repos.push(top);
        }
    }
    return repos;
}

/** True when the repository at `repo` has the commit `id`. */
export function hasCommit(
    git: Git,
    repo: string,
    id: string,
    options: OperationOptions = {},
): Promise<boolean> {
    return revisionExists(git, repo, id, 'commit', options);
}

/** True when `revision` names a commit or tree in the repository at `repo`. */
export function isRevision(
    git: Git,
    repo: string,
    revision: string,
    options: OperationOptions = {},
): Promise<boolean> {
    return revisionExists(git, repo, revision, 'tree', options);
}

async function revisionExists(
    git: Git,
    repo: string,
    revision: string,
    type: 'commit' | 'tree',
    options: OperationOptions,
): Promise<boolean> {
    throwIfAborted(options.signal);
    if (revision === '' || revision.startsWith('-')) {
        return false;
    }
    try {
        await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{${type}}`], {
            ...options,
            cwd: repo,
        });
        throwIfAborted(options.signal);
        return true;
    } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof GitError && error.exitCode === 1) {
            return false;
        }
        throw error;
    }
}

/** The base for a patch made from `commit`: the commit's parent, or the empty tree when it is a first commit. */
export async function parentOf(
    git: Git,
    repo: string,
    commit: string,
    options: OperationOptions = {},
): Promise<string> {
    return (await commitParent(git, repo, commit, options)).base;
}

/**
 * The parents of `commit`, in parent order, and an empty list for a root commit.
 *
 * Parents come from `rev-parse commit^@`, which follows how the repository presents the commit: in a shallow
 * clone a boundary commit lists no parents here even though its object header names some, unlike `parentOf`.
 */
export async function commitParents(
    git: Git,
    repo: string,
    commit: string,
    options: OperationOptions = {},
): Promise<string[]> {
    throwIfAborted(options.signal);
    if (commit === '' || commit.startsWith('-')) {
        throw new Error('The commit must be a nonempty revision, not a Git option.');
    }
    const gitOptions = { ...options, cwd: repo };
    const id = await git.text(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], gitOptions);
    throwIfAborted(options.signal);
    // Plain rev-parse echoes --end-of-options; the id is already a verified full hash, so none is needed.
    const listed = await git.text(['rev-parse', `${id}^@`], gitOptions);
    throwIfAborted(options.signal);
    const parents = listed === '' ? [] : listed.split('\n');
    for (const parent of parents) {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent)) {
            throw new Error('Git returned an invalid parent commit identifier.');
        }
    }
    return parents;
}

interface CommitParent {
    readonly base: string;
    readonly revision: string;
}

async function commitParent(
    git: Git,
    repo: string,
    commit: string,
    options: OperationOptions,
): Promise<CommitParent> {
    throwIfAborted(options.signal);
    if (commit === '' || commit.startsWith('-')) {
        throw new Error('The commit must be a nonempty revision, not a Git option.');
    }
    const gitOptions = { ...options, cwd: repo };
    const id = await git.text(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], gitOptions);
    throwIfAborted(options.signal);
    const raw = await git.text(['cat-file', 'commit', id], gitOptions);
    throwIfAborted(options.signal);
    // Read the object header, not traversal output: a shallow boundary is not a root commit.
    const parent = /^parent ([0-9a-f]+)$/m.exec(raw.split('\n\n', 1)[0])?.[1];
    if (parent) {
        return { base: `${commit}^`, revision: parent };
    }
    const empty = await git.text(['hash-object', '-t', 'tree', '--stdin'], gitOptions);
    throwIfAborted(options.signal);
    return { base: empty, revision: empty };
}

/**
 * Finds where `patch` applies among the `candidates` repositories.
 *
 * When the patch names its commit, the first candidate that has that commit is used, with the commit's parent as the
 * base. When no candidate has it, or the patch names none, the patch is tried on HEAD in every candidate.
 */
export async function resolvePatch(
    git: Git,
    candidates: readonly string[],
    patch: Uint8Array,
    commit?: string,
    options: OperationOptions = {},
): Promise<Resolution> {
    throwIfAborted(options.signal);
    if (commit !== undefined && (commit === '' || commit.startsWith('-'))) {
        throw new Error('The commit must be a nonempty revision, not a Git option.');
    }
    if (commit) {
        for (const repo of candidates) {
            throwIfAborted(options.signal);
            if (await hasCommit(git, repo, commit, options)) {
                const parent = await commitParent(git, repo, commit, options);
                const outcome = await attempt(git, repo, parent.base, patch, options, parent.revision);
                if ('applied' in outcome) {
                    return { targets: [outcome], failures: [], commitRepo: repo };
                }
                return {
                    targets: [],
                    failures: [outcome],
                    commitRepo: repo,
                    ...await alreadyAppliedIn(git, candidates, patch, options),
                };
            }
        }
    }
    const targets: PatchTarget[] = [];
    const failures: FailedAttempt[] = [];
    for (const repo of candidates) {
        throwIfAborted(options.signal);
        const outcome = await attempt(git, repo, 'HEAD', patch, options);
        if ('applied' in outcome) {
            targets.push(outcome);
        } else {
            failures.push(outcome);
        }
    }
    if (targets.length > 0) {
        return { targets, failures };
    }
    return { targets, failures, ...await alreadyAppliedIn(git, candidates, patch, options) };
}

async function attempt(
    git: Git,
    repo: string,
    base: string,
    patch: Uint8Array,
    options: OperationOptions,
    revision = base,
): Promise<PatchTarget | FailedAttempt> {
    throwIfAborted(options.signal);
    try {
        const applied = await applyPatch(git, repo, revision, patch, options);
        throwIfAborted(options.signal);
        return { repo, base, applied };
    } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof GitError && error.exitCode !== null && isApplyCommand(error.args)) {
            return { repo, base, reason: error.message };
        }
        throw error;
    }
}

function isApplyCommand(args: readonly string[]): boolean {
    let index = 0;
    while (args[index] === '-c') {
        index += 2;
    }
    return args[index] === 'apply';
}

// Mirrors patch.ts: scratch commands must not inherit index features that would write beside the private index.
const SCRATCH_CONFIG = [
    '-c', 'core.splitIndex=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'core.sparseCheckout=false',
    '-c', 'index.sparse=false',
];

/** The already-applied flags for a resolution, or nothing when no repository's HEAD contains the change. */
async function alreadyAppliedIn(
    git: Git,
    candidates: readonly string[],
    patch: Uint8Array,
    options: OperationOptions,
): Promise<Pick<Resolution, 'alreadyApplied'>> {
    const found = await detectAlreadyApplied(git, candidates, patch, options);
    return found.length > 0 ? { alreadyApplied: found } : {};
}

/**
 * The candidate repositories whose HEAD content already contains the patch: every diff-bearing message
 * reverse-applies cleanly on HEAD.
 *
 * One `git apply --cached --reverse --check` invocation checks the whole input, series included: with `--reverse`,
 * Git validates the messages against each other so a fully applied series passes and a partially applied one does
 * not, which the unit tests pin down on the supported Git versions. The scan is advisory: a Git failure or an
 * output limit leaves a repository unflagged, and an expired shared deadline stops the scan with the repositories
 * flagged so far instead of failing a resolution that is already complete. Cancellation still propagates.
 */
async function detectAlreadyApplied(
    git: Git,
    candidates: readonly string[],
    patch: Uint8Array,
    controls: OperationOptions,
): Promise<{ repo: string; revision: string }[]> {
    const applicable = splitPatchMessages(patch).filter(message => message.hasDiff);
    // An undecodable diff-bearing message prevents the flag; resolvePatch normally rejects such patches while
    // applying forward, so this guard is defence in depth for the advisory scan.
    if (applicable.length === 0 || applicable.some(message => message.encodingError !== undefined)) {
        return [];
    }
    const diffs = Buffer.concat(applicable.map(message => message.decodedBytes ?? message.bytes));
    const timeoutMs = positiveLimit('timeoutMs', controls.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    const flagged: { repo: string; revision: string }[] = [];
    for (const repo of candidates) {
        throwIfAborted(controls.signal);
        if (Date.now() >= deadline) {
            return flagged;
        }
        try {
            const revision = await reverseAppliesOnHead(git, repo, diffs, controls, deadline, timeoutMs);
            if (revision !== undefined) {
                flagged.push({ repo, revision });
            }
        } catch (error) {
            throwIfAborted(controls.signal);
            if (error instanceof OperationTimeoutError) {
                return flagged;
            }
            if (!(error instanceof GitError) && !(error instanceof OperationLimitError)) {
                throw error;
            }
        }
    }
    return flagged;
}

/**
 * The displayed revision, such as `HEAD (abc1234)`, when the patch reverse-applies cleanly on the repository's
 * HEAD, and undefined when it does not.
 *
 * The check seeds a private scratch index from the frozen HEAD tree and validates with `--check`, which writes
 * no object and leaves the index untouched, so the source repository only ever serves reads.
 */
async function reverseAppliesOnHead(
    git: Git,
    repo: string,
    diffs: Buffer,
    controls: OperationOptions,
    deadline: number,
    timeoutMs: number,
): Promise<string | undefined> {
    const optionsFor = (env?: Readonly<Record<string, string>>): GitOptions => {
        throwIfAborted(controls.signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new OperationTimeoutError(timeoutMs);
        }
        return { ...controls, cwd: repo, env, timeoutMs: remaining };
    };
    const head = await git.text(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], optionsFor());
    const short = await git.text(['rev-parse', '--verify', '--short', '--end-of-options', head], optionsFor());
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
        await git.run([...SCRATCH_CONFIG, 'read-tree', `${head}^{tree}`], optionsFor(env));
        try {
            await git.run(
                [...SCRATCH_CONFIG, 'apply', '--cached', '--reverse', '--check', '--whitespace=nowarn', '-'],
                { ...optionsFor(env), input: diffs },
            );
        } catch (error) {
            if (error instanceof GitError && error.exitCode !== null) {
                return undefined;
            }
            throw error;
        }
        return `HEAD (${short})`;
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}
