import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError } from '../../git';
import { findRepositories, hasCommit, isRevision, parentOf, resolvePatch, topLevel } from '../../repositories';
import { canonical, commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const gitTool = new Git();

after(removeTempDirs);

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
    });

    test('parentOf names the parent commit', async () => {
        const { repo, commit } = twoCommits();
        assert.equal(await parentOf(gitTool, repo, commit), `${commit}^`);
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
});
