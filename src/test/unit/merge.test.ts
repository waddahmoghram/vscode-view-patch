import * as assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError, GitOptions } from '../../git';
import { OperationCancelledError, OperationLimitError } from '../../operations';
import { FileChange, mergeChanges } from '../../patch';
import { commitParents } from '../../repositories';
import { commitAll, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const gitTool = new Git();

after(removeTempDirs);

// A two-parent merge: main adds main.txt while feature edits a.txt and adds feature.txt.
function twoParentMerge(): { repo: string; main: string; feature: string; merge: string } {
    const repo = makeRepo({ 'a.txt': 'base\n' });
    git(repo, 'checkout', '-qb', 'feature');
    writeFiles(repo, { 'a.txt': 'feat\n', 'feature.txt': 'f\n' });
    const feature = commitAll(repo, 'Feature work');
    git(repo, 'checkout', '-q', 'main');
    writeFiles(repo, { 'main.txt': 'm\n' });
    const main = commitAll(repo, 'Main work');
    git(repo, 'merge', '-q', '--no-edit', 'feature');
    return { repo, main, feature, merge: git(repo, 'rev-parse', 'HEAD').trim() };
}

function contentOnly({ status, newPath, before, after: result }: FileChange) {
    return { status, newPath, before: before?.toString(), after: result?.toString() };
}

const byNewPath = (a: { newPath: string }, b: { newPath: string }): number => a.newPath.localeCompare(b.newPath);

describe('mergeChanges', () => {
    test('loads what a two-parent merge changed against each parent', async () => {
        const { repo, main, feature, merge } = twoParentMerge();

        const changes = await mergeChanges(gitTool, repo, 'HEAD');

        assert.equal(changes.commit, merge);
        assert.deepEqual(changes.parents, [main, feature]);
        assert.deepEqual(changes.perParent.map(entry => entry.parent), [main, feature]);
        const [againstMain, againstFeature] = changes.perParent;
        assert.deepEqual([...againstMain.changes].sort(byNewPath).map(contentOnly), [
            { status: 'M', newPath: 'a.txt', before: 'base\n', after: 'feat\n' },
            { status: 'A', newPath: 'feature.txt', before: undefined, after: 'f\n' },
        ]);
        assert.deepEqual([...againstFeature.changes].sort(byNewPath).map(contentOnly), [
            { status: 'A', newPath: 'main.txt', before: undefined, after: 'm\n' },
        ]);
        assert.deepEqual(changes.perParent.flatMap(entry => [...entry.skipped]), []);
    });

    test('preserves parent order for a three-parent octopus merge', async () => {
        const repo = makeRepo({ 'a.txt': 'base\n' });
        for (const branch of ['b1', 'b2']) {
            git(repo, 'checkout', '-qb', branch, 'main');
            writeFiles(repo, { [`${branch}.txt`]: `${branch}\n` });
            commitAll(repo, `Branch ${branch}`);
        }
        git(repo, 'checkout', '-q', 'main');
        writeFiles(repo, { 'main.txt': 'm\n' });
        commitAll(repo, 'Main tip');
        git(repo, 'merge', '-q', '--no-edit', 'b1', 'b2');
        const expected = [1, 2, 3].map(parent => git(repo, 'rev-parse', `HEAD^${parent}`).trim());

        const changes = await mergeChanges(gitTool, repo, 'HEAD');

        assert.deepEqual(changes.parents, expected);
        assert.deepEqual(changes.perParent.map(entry => [
            entry.parent,
            entry.changes.map(change => change.newPath).sort(),
        ]), [
            [expected[0], ['b1.txt', 'b2.txt']],
            [expected[1], ['b2.txt', 'main.txt']],
            [expected[2], ['b1.txt', 'main.txt']],
        ]);
        assert.deepEqual(await commitParents(gitTool, repo, 'HEAD'), expected);
    });

    test('returns no per-parent changes for a root commit and never hashes the empty tree', async () => {
        const repo = makeRepo({ 'a.txt': 'first\n' });
        const root = git(repo, 'rev-parse', 'HEAD').trim();
        const commands: string[][] = [];
        class RecordingGit extends Git {
            override run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                commands.push([...args]);
                return super.run(args, options);
            }
        }

        const changes = await mergeChanges(new RecordingGit(), repo, root);

        assert.deepEqual(changes, { commit: root, parents: [], perParent: [] });
        assert.equal(commands.some(args => args.includes('hash-object')), false);
    });

    test('resolves symbolic revisions to the commit hash', async () => {
        const { repo, merge } = twoParentMerge();
        assert.equal((await mergeChanges(gitTool, repo, 'main')).commit, merge);
    });

    test('runs no writing command and leaves the source bytes, modes, and timestamps alone', async () => {
        const { repo } = twoParentMerge();
        const snapshot = () => ({
            objects: git(repo, 'count-objects', '-v'),
            refs: git(repo, 'show-ref'),
            files: snapshotFiles(repo),
        });
        const before = snapshot();
        const commands: string[][] = [];
        class RecordingGit extends Git {
            override run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                commands.push([...args]);
                return super.run(args, options);
            }
        }
        const scratchRoot = tempDir('view-patch-merge-');

        const changes = await withTempRoot(scratchRoot, () => mergeChanges(new RecordingGit(), repo, 'HEAD'));

        assert.equal(changes.perParent.length, 2);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(readdirSync(scratchRoot), []);
        const writers = ['apply', 'write-tree', 'hash-object', 'update-index', 'read-tree'];
        for (const args of commands) {
            assert.equal(writers.some(writer => args.includes(writer)), false, `writer among: ${args.join(' ')}`);
        }
    });

    test('applies one content budget across every parent', async () => {
        const { repo } = twoParentMerge();
        // Unique blobs: a.txt base\n (5 bytes) and feat\n (5), feature.txt f\n (2), main.txt m\n (2) - 14 in all.
        const changes = await mergeChanges(gitTool, repo, 'HEAD', { maxContentBytes: 14 });
        assert.equal(changes.perParent.length, 2);
        await assert.rejects(mergeChanges(gitTool, repo, 'HEAD', { maxContentBytes: 13 }), OperationLimitError);
    });

    test('rejects option-like commits and aborted signals before invoking Git', async () => {
        class UnreachableGit extends Git {
            override run(): Promise<Buffer> {
                throw new Error('Git must not run.');
            }
        }
        const unreachable = new UnreachableGit();
        for (const commit of ['', '--all', '-n1']) {
            await assert.rejects(mergeChanges(unreachable, 'unused-repo', commit), /not a Git option/);
        }
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            mergeChanges(unreachable, 'unused-repo', 'HEAD', { signal: controller.signal }),
            OperationCancelledError,
        );
    });

    test('fails with a GitError for revisions that are not commits', async () => {
        const { repo } = twoParentMerge();
        await assert.rejects(mergeChanges(gitTool, repo, git(repo, 'rev-parse', 'HEAD^{tree}').trim()), GitError);
        await assert.rejects(mergeChanges(gitTool, repo, 'no-such-branch'), GitError);
    });
});

// Mirrors patch.test.ts: byte, mode, and timestamp snapshots prove the source repository served reads only.
function snapshotFiles(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    const visit = (relative: string): void => {
        const absolute = path.join(root, relative);
        const stat = lstatSync(absolute, { bigint: true });
        const attributes = `${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (stat.isDirectory()) {
            files[relative] = `directory:${attributes}`;
            for (const name of readdirSync(absolute).sort()) {
                visit(path.join(relative, name));
            }
        } else {
            const bytes = stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute).toString('base64');
            files[relative] = `${attributes}:${bytes}`;
        }
    };
    visit('');
    return files;
}

// os.tmpdir() reads TMPDIR on Linux and macOS, and TEMP or TMP on Windows.
async function withTempRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
    const names = ['TMPDIR', 'TEMP', 'TMP'];
    const saved = names.map(name => process.env[name]);
    names.forEach(name => (process.env[name] = root));
    try {
        return await run();
    } finally {
        names.forEach((name, i) => {
            if (saved[i] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[i];
            }
        });
    }
}
