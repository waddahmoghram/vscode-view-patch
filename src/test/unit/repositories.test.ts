import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Git, GitError, GitOptions } from '../../git';
import {
    OperationCancelledError,
    OperationLimitError,
    OperationOptions,
    OperationTimeoutError,
} from '../../operations';
import { findRepositories, hasCommit, isRevision, parentOf, resolvePatch, topLevel } from '../../repositories';
import { canonical, commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const gitTool = new Git();
const sampleDiff = Buffer.from([
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    '',
].join('\n'));
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
// Project-local scratch folders must not discover the checkout containing the test run.
process.env.GIT_CEILING_DIRECTORIES = canonical(os.tmpdir());

after(removeTempDirs);
after(() => {
    if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
    } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
});

class FailingGit extends Git {
    calls = 0;

    constructor(readonly failure: Error) {
        super();
    }

    override run(_args: readonly string[], _options: GitOptions): Promise<Buffer> {
        this.calls++;
        return Promise.reject(this.failure);
    }
}

class RecordingGit extends Git {
    readonly calls: { readonly args: readonly string[]; readonly options: GitOptions }[] = [];

    override run(args: readonly string[], options: GitOptions): Promise<Buffer> {
        this.calls.push({ args, options });
        return super.run(args, options);
    }
}

// A repository with two commits; the patch and plain diff describe the second one.
function twoCommits(): { repo: string; commit: string; patch: Buffer; diff: Buffer } {
    const repo = makeRepo({ 'a.txt': 'one\n' });
    writeFiles(repo, { 'a.txt': 'two\n' });
    const commit = commitAll(repo, 'Second');
    return {
        repo,
        commit,
        patch: Buffer.from(formatPatch(repo, commit)),
        diff: Buffer.from(git(repo, 'diff', `${commit}^`, commit)),
    };
}

describe('Git', () => {
    test('reports a Git executable that does not exist', async () => {
        const missing = new Git(path.join(tempDir(), 'no-such-git'));
        await assert.rejects(missing.run(['--version'], { cwd: os.tmpdir() }), (error: unknown) => {
            return error instanceof GitError && error.exitCode === null && /was not found/.test(error.message);
        });
        await assert.rejects(missing.succeeds(['--version'], { cwd: os.tmpdir() }), GitError);
    });

    test('reports a working folder that does not exist', async () => {
        await assert.rejects(gitTool.run(['--version'], { cwd: path.join(tempDir(), 'gone') }), /does not exist/);
    });

    test('ignores Git location variables set in the environment', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        process.env.GIT_DIR = path.join(tempDir(), 'elsewhere');
        try {
            assert.equal(canonical((await topLevel(gitTool, repo)) ?? ''), canonical(repo));
        } finally {
            delete process.env.GIT_DIR;
        }
    });

    test('blocks even local remote transports', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        await assert.rejects(
            gitTool.run(['ls-remote', pathToFileURL(repo).href], { cwd: repo }),
            (error: unknown) => error instanceof GitError && /transport 'file' not allowed/.test(error.message),
        );
    });
});

describe('findRepositories', () => {
    test('finds each top folder once, in order, and drops folders outside Git', async () => {
        const first = makeRepo({ 'sub/dir/file.txt': 'x\n' });
        const second = makeRepo({ 'b.txt': 'y\n' });
        const outside = tempDir();
        const found = await findRepositories(gitTool, [
            path.join(first, 'sub', 'dir'),
            outside,
            path.join(outside, 'missing'),
            second,
            first,
        ]);
        assert.deepEqual(found.map(canonical), [canonical(first), canonical(second)]);
    });

    test('does not treat a file as a folder', async () => {
        const repo = makeRepo({ 'a.txt': 'x\n' });
        assert.equal(await topLevel(gitTool, path.join(repo, 'a.txt')), undefined);
    });

    test('does not treat a bare repository as a working tree', async () => {
        const folder = tempDir();
        git(folder, 'init', '-q', '--bare');
        assert.equal(await topLevel(gitTool, folder), undefined);
    });

    test('finds linked worktrees in paths with spaces', async () => {
        const repo = makeRepo({ 'a.txt': 'x\n' });
        const worktree = path.join(tempDir('view patch '), 'work tree');
        git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
        assert.deepEqual((await findRepositories(gitTool, [worktree, repo])).map(canonical), [
            canonical(worktree),
            canonical(repo),
        ]);
    });

    test('surfaces filesystem permission errors', async context => {
        const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const mocked = mock.method(fs, 'stat', async () => { throw denied; });
        context.after(() => mocked.mock.restore());
        await assert.rejects(topLevel(gitTool, 'unreadable-folder'), error => error === denied);
    });

    test('surfaces Git permission and other discovery failures', async () => {
        const folder = tempDir();
        for (const message of ['fatal: permission denied', 'fatal: detected dubious ownership in repository']) {
            const failure = new GitError(message, ['rev-parse', '--show-toplevel'], 128);
            await assert.rejects(topLevel(new FailingGit(failure), folder), error => error === failure);
        }
    });

    test('checks cancellation before moving to the next folder', async () => {
        const controller = new AbortController();
        let calls = 0;
        class CancellingGit extends Git {
            override async run(_args: readonly string[], _options: GitOptions): Promise<Buffer> {
                calls++;
                controller.abort();
                return Buffer.from('unused-repository\n');
            }
        }
        await assert.rejects(
            findRepositories(new CancellingGit(), [tempDir(), tempDir()], { signal: controller.signal }),
            OperationCancelledError,
        );
        assert.equal(calls, 1);
    });
});

describe('revisions', () => {
    test('hasCommit and isRevision answer for this repository only', async () => {
        const { repo, commit } = twoCommits();
        assert.equal(await hasCommit(gitTool, repo, commit), true);
        assert.equal(await hasCommit(gitTool, repo, '0123456789abcdef0123456789abcdef01234567'), false);
        assert.equal(await isRevision(gitTool, repo, 'main'), true);
        assert.equal(await isRevision(gitTool, repo, `${commit}^`), true);
        assert.equal(await isRevision(gitTool, repo, 'no-such-branch'), false);
        assert.equal(await isRevision(gitTool, repo, '--all'), false);
        assert.equal(await isRevision(gitTool, repo, ''), false);
        assert.equal(await hasCommit(gitTool, repo, '--all'), false);
        assert.equal(await hasCommit(gitTool, repo, ''), false);
        const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
        assert.equal(await isRevision(gitTool, repo, tree), true);
        assert.equal(await hasCommit(gitTool, repo, tree), false);
    });

    test('parentOf names the parent commit', async () => {
        const { repo, commit } = twoCommits();
        assert.equal(await parentOf(gitTool, repo, commit), `${commit}^`);
    });

    test('parentOf returns the empty tree only for a real root commit', async () => {
        const repo = makeRepo({ 'a.txt': 'first\n' });
        const commit = git(repo, 'rev-parse', 'HEAD').trim();
        const objectsBefore = git(repo, 'count-objects', '-v');
        assert.equal(await parentOf(gitTool, repo, commit), git(repo, 'hash-object', '-t', 'tree', '--stdin').trim());
        assert.equal(git(repo, 'count-objects', '-v'), objectsBefore);
        await assert.rejects(parentOf(gitTool, repo, 'no-such-commit'), GitError);
    });

    test('parentOf does not mistake a shallow boundary for a root', async () => {
        const { repo, commit } = twoCommits();
        const shallow = path.join(tempDir(), 'shallow clone');
        git(repo, 'clone', '-q', '--depth=1', pathToFileURL(repo).href, shallow);
        assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository').trim(), 'true');
        assert.equal(await parentOf(gitTool, shallow, commit), `${commit}^`);
        assert.equal(await isRevision(gitTool, shallow, `${commit}^`), false);
    });

    test('rejects option-like parent revisions without invoking Git', async () => {
        const failing = new FailingGit(new Error('Git must not run'));
        for (const revision of ['', '--all', '-n1']) {
            await assert.rejects(parentOf(failing, 'unused-repo', revision), /not a Git option/);
        }
        assert.equal(failing.calls, 0);
    });

    test('distinguishes a missing revision from repository failures', async () => {
        const missing = new FailingGit(new GitError('missing revision', ['rev-parse'], 1));
        assert.equal(await isRevision(missing, 'repo', 'missing'), false);
        assert.equal(await hasCommit(missing, 'repo', 'missing'), false);
        const failure = new GitError('fatal: permission denied', ['rev-parse'], 128);
        const failing = new FailingGit(failure);
        await assert.rejects(isRevision(failing, 'repo', 'main'), error => error === failure);
        await assert.rejects(hasCommit(failing, 'repo', 'main'), error => error === failure);
    });
});

describe('resolvePatch', () => {
    test('uses the repository that has the patch commit, on that commit\'s parent', async () => {
        const { repo, commit, patch } = twoCommits();
        const other = makeRepo({ 'b.txt': 'x\n' });

        const resolution = await resolvePatch(gitTool, [other, repo], patch, commit);
        assert.equal(resolution.commitRepo, repo);
        assert.deepEqual(resolution.failures, []);
        assert.deepEqual(
            resolution.targets.map(target => [target.repo, target.base]),
            [[repo, `${commit}^`]],
        );
    });

    test('reports the failure in the repository that has the commit, without trying others', async () => {
        const { repo, commit, patch } = twoCommits();
        const edited = Buffer.from(patch.toString().replace('-one', '-uno'));

        const resolution = await resolvePatch(gitTool, [repo, makeRepo({ 'a.txt': 'uno\n' })], edited, commit);
        assert.equal(resolution.commitRepo, repo);
        assert.deepEqual(resolution.targets, []);
        assert.deepEqual(resolution.failures.map(failure => [failure.repo, failure.base]), [[repo, `${commit}^`]]);
        assert.match(resolution.failures[0].reason, /patch does not apply/);
    });

    test('tries HEAD in every repository when the patch names no commit', async () => {
        const { repo, commit, diff } = twoCommits();
        git(repo, 'checkout', '-q', '--detach', `${commit}^`);
        const other = makeRepo({ 'b.txt': 'x\n' });

        const resolution = await resolvePatch(gitTool, [other, repo], diff);
        assert.equal(resolution.commitRepo, undefined);
        assert.deepEqual(resolution.targets.map(target => [target.repo, target.base]), [[repo, 'HEAD']]);
        assert.deepEqual(resolution.failures.map(failure => [failure.repo, failure.base]), [[other, 'HEAD']]);
    });

    test('tries HEAD when no repository has the commit the patch names', async () => {
        const { repo, commit, diff } = twoCommits();
        git(repo, 'checkout', '-q', '--detach', `${commit}^`);

        const resolution = await resolvePatch(gitTool, [repo], diff, '0123456789abcdef0123456789abcdef01234567');
        assert.deepEqual(resolution.targets.map(target => [target.repo, target.base]), [[repo, 'HEAD']]);
    });

    test('returns every repository where the patch applies', async () => {
        const { repo, commit, diff } = twoCommits();
        const clone = path.join(tempDir(), 'clone');
        git(repo, 'clone', '-q', repo, clone);
        git(repo, 'checkout', '-q', '--detach', `${commit}^`);
        git(clone, 'checkout', '-q', '--detach', `${commit}^`);

        const resolution = await resolvePatch(gitTool, [repo, clone], diff);
        assert.deepEqual(resolution.targets.map(target => target.repo), [repo, clone]);
    });

    test('applies a root commit without writing source objects', async () => {
        const repo = makeRepo({ 'a.txt': 'first\n' });
        const commit = git(repo, 'rev-parse', 'HEAD').trim();
        const objectsBefore = git(repo, 'count-objects', '-v');
        const resolution = await resolvePatch(gitTool, [repo], Buffer.from(formatPatch(repo)), commit);
        assert.equal(resolution.targets.length, 1);
        assert.equal(resolution.targets[0].applied.changes[0].before, undefined);
        assert.equal(resolution.targets[0].applied.changes[0].after?.toString(), 'first\n');
        assert.equal(git(repo, 'count-objects', '-v'), objectsBefore);
    });

    test('applies in a linked worktree with spaces without changing its state', async () => {
        const { repo, commit, diff } = twoCommits();
        const base = git(repo, 'rev-parse', `${commit}^`).trim();
        const worktree = path.join(tempDir('view patch '), 'work tree');
        git(repo, 'worktree', 'add', '-q', '--detach', worktree, base);
        const objectsBefore = git(repo, 'count-objects', '-v');
        const resolution = await resolvePatch(gitTool, [worktree], diff);
        assert.deepEqual(resolution.targets.map(target => [target.repo, target.base]), [[worktree, 'HEAD']]);
        assert.equal(resolution.targets[0].applied.changes[0].after?.toString(), 'two\n');
        assert.equal(git(worktree, 'rev-parse', 'HEAD').trim(), base);
        assert.equal(git(worktree, 'status', '--porcelain'), '');
        assert.equal(git(repo, 'count-objects', '-v'), objectsBefore);
    });

    test('preserves a requested base label while using the frozen commit parent', async () => {
        const { repo, commit, patch } = twoCommits();
        const first = git(repo, 'rev-parse', `${commit}^`).trim();
        class MovingGit extends Git {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                const output = await super.run(args, options);
                if (args[0] === 'cat-file' && args[1] === 'commit') {
                    git(repo, 'update-ref', 'refs/heads/main', first);
                }
                return output;
            }
        }
        const resolution = await resolvePatch(new MovingGit(), [repo], patch, 'main');
        assert.deepEqual(resolution.targets.map(target => target.base), ['main^']);
        assert.equal(resolution.targets[0].applied.changes[0].after?.toString(), 'two\n');
    });

    test('checks cancellation between candidate commit probes', async () => {
        const controller = new AbortController();
        let calls = 0;
        class CancellingGit extends Git {
            override run(args: readonly string[], _options: GitOptions): Promise<Buffer> {
                calls++;
                controller.abort();
                return Promise.reject(new GitError('missing revision', args, 1));
            }
        }
        await assert.rejects(
            resolvePatch(new CancellingGit(), ['first', 'second'], Buffer.alloc(0), 'commit', {
                signal: controller.signal,
            }),
            OperationCancelledError,
        );
        assert.equal(calls, 1);
    });

    test('rejects option-like commit arguments instead of falling back to HEAD', async () => {
        const failing = new FailingGit(new Error('Git must not run'));
        for (const commit of ['', '--all', '-n1']) {
            await assert.rejects(resolvePatch(failing, ['repo'], Buffer.alloc(0), commit), /not a Git option/);
        }
        assert.equal(failing.calls, 0);
    });

    test('surfaces repository failures instead of reporting a patch mismatch', async () => {
        const failure = new GitError('fatal: invalid repository', ['rev-parse', '--git-path', 'objects'], 128);
        await assert.rejects(
            resolvePatch(new FailingGit(failure), ['repo'], sampleDiff),
            error => error === failure,
        );
    });
});

describe('repository operation options', () => {
    test('propagates options through discovery, revision checks, parent lookup, and patch application', async () => {
        const { repo, commit, patch } = twoCommits();
        const recording = new RecordingGit();
        const operation: OperationOptions = {
            signal: new AbortController().signal,
            timeoutMs: 5_000,
            maxOutputBytes: 1024 * 1024,
            maxPatchBytes: 1024 * 1024,
            maxContentBytes: 1024 * 1024,
        };
        await topLevel(recording, repo, operation);
        await findRepositories(recording, [repo], operation);
        await hasCommit(recording, repo, commit, operation);
        await isRevision(recording, repo, commit, operation);
        await parentOf(recording, repo, commit, operation);
        await resolvePatch(recording, [repo], patch, commit, operation);
        assert.ok(recording.calls.length > 10);
        for (const call of recording.calls) {
            assert.equal(call.options.signal, operation.signal);
            assert.ok(call.options.timeoutMs !== undefined && call.options.timeoutMs > 0);
            assert.ok(call.options.timeoutMs <= 5_000);
            assert.ok(call.options.maxOutputBytes !== undefined && call.options.maxOutputBytes > 0);
            assert.ok(call.options.maxOutputBytes <= 1024 * 1024);
            assert.equal(call.options.maxPatchBytes, operation.maxPatchBytes);
            assert.equal(call.options.maxContentBytes, operation.maxContentBytes);
        }
    });

    test('passes patch-size limits into applyPatch', async () => {
        const { repo, commit, patch } = twoCommits();
        await assert.rejects(
            resolvePatch(gitTool, [repo], patch, commit, { maxPatchBytes: 1 }),
            OperationLimitError,
        );
    });

    test('checks already aborted options even for empty inputs and invalid revisions', async () => {
        const controller = new AbortController();
        controller.abort();
        const operation = { signal: controller.signal };
        const failing = new FailingGit(new Error('Git must not run'));
        await assert.rejects(topLevel(failing, 'missing-folder', operation), OperationCancelledError);
        await assert.rejects(findRepositories(failing, [], operation), OperationCancelledError);
        await assert.rejects(hasCommit(failing, 'repo', '', operation), OperationCancelledError);
        await assert.rejects(isRevision(failing, 'repo', '', operation), OperationCancelledError);
        await assert.rejects(parentOf(failing, 'repo', '', operation), OperationCancelledError);
        await assert.rejects(
            resolvePatch(failing, [], Buffer.alloc(0), undefined, operation),
            OperationCancelledError,
        );
        assert.equal(failing.calls, 0);
    });

    for (const failure of [
        new OperationCancelledError(),
        new OperationTimeoutError(1),
        new OperationLimitError('fixture output limit'),
    ]) {
        test(`does not convert ${failure.name} into a missing repository, revision, or patch mismatch`, async () => {
            const folder = tempDir();
            const failing = new FailingGit(failure);
            await assert.rejects(topLevel(failing, folder), error => error === failure);
            await assert.rejects(findRepositories(failing, [folder]), error => error === failure);
            await assert.rejects(hasCommit(failing, folder, 'main'), error => error === failure);
            await assert.rejects(isRevision(failing, folder, 'main'), error => error === failure);
            await assert.rejects(parentOf(failing, folder, 'main'), error => error === failure);
            await assert.rejects(resolvePatch(failing, [folder], sampleDiff), error => error === failure);
            await assert.rejects(
                resolvePatch(failing, [folder], sampleDiff, 'commit'),
                error => error === failure,
            );
        });
    }
});
