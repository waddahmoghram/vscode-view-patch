import { promises as fs } from 'fs';
import * as path from 'path';
import { Git, GitError } from './git';
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
export async function topLevel(git: Git, folder: string): Promise<string | undefined> {
    try {
        if (!(await fs.stat(folder)).isDirectory()) {
            return undefined;
        }
    } catch {
        return undefined;
    }
    try {
        const top = await git.text(['rev-parse', '--show-toplevel'], { cwd: folder });
        return top ? path.normalize(top) : undefined;
    } catch (error) {
        if (error instanceof GitError && error.exitCode !== null) {
            return undefined;
        }
        throw error;
    }
}

/** The repositories that hold `folders`, in order and without repeats. Folders outside Git are left out. */
export async function findRepositories(git: Git, folders: readonly string[]): Promise<string[]> {
    const tops = await Promise.all(folders.map(folder => topLevel(git, folder)));
    const seen = new Set<string>();
    const repos: string[] = [];
    for (const top of tops) {
        const key = top && (process.platform === 'win32' ? top.toLowerCase() : top);
        if (top && key && !seen.has(key)) {
            seen.add(key);
            repos.push(top);
        }
    }
    return repos;
}

/** True when the repository at `repo` has the commit `id`. */
export function hasCommit(git: Git, repo: string, id: string): Promise<boolean> {
    return git.succeeds(['cat-file', '-e', `${id}^{commit}`], { cwd: repo });
}

/** True when `revision` names a commit or tree in the repository at `repo`. */
export async function isRevision(git: Git, repo: string, revision: string): Promise<boolean> {
    if (revision === '' || revision.startsWith('-')) {
        return false;
    }
    return git.succeeds(['rev-parse', '--verify', '--quiet', `${revision}^{tree}`], { cwd: repo });
}

/** The base for a patch made from `commit`: the commit's parent, or the empty tree when it is a first commit. */
export async function parentOf(git: Git, repo: string, commit: string): Promise<string> {
    if (await git.succeeds(['rev-parse', '--verify', '--quiet', `${commit}^`], { cwd: repo })) {
        return `${commit}^`;
    }
    return git.text(['hash-object', '-t', 'tree', '--stdin'], { cwd: repo });
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
): Promise<Resolution> {
    if (commit) {
        for (const repo of candidates) {
            if (await hasCommit(git, repo, commit)) {
                const outcome = await attempt(git, repo, await parentOf(git, repo, commit), patch);
                return 'applied' in outcome
                    ? { targets: [outcome], failures: [], commitRepo: repo }
                    : { targets: [], failures: [outcome], commitRepo: repo };
            }
        }
    }
    const targets: PatchTarget[] = [];
    const failures: FailedAttempt[] = [];
    for (const repo of candidates) {
        const outcome = await attempt(git, repo, 'HEAD', patch);
        if ('applied' in outcome) {
            targets.push(outcome);
        } else {
            failures.push(outcome);
        }
    }
    return { targets, failures };
}

async function attempt(git: Git, repo: string, base: string, patch: Uint8Array): Promise<PatchTarget | FailedAttempt> {
    try {
        return { repo, base, applied: await applyPatch(git, repo, base, patch) };
    } catch (error) {
        if (error instanceof GitError && error.exitCode !== null) {
            return { repo, base, reason: error.message };
        }
        throw error;
    }
}
