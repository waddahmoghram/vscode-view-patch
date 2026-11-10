import { promises as fs } from 'fs';
import * as path from 'path';
import { Git, GitError } from './git';
import { OperationOptions, throwIfAborted } from './operations';
import { AppliedPatch, applyPatch } from './patch';

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
                return 'applied' in outcome
                    ? { targets: [outcome], failures: [], commitRepo: repo }
                    : { targets: [], failures: [outcome], commitRepo: repo };
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
    return { targets, failures };
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
