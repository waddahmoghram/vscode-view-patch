import * as assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError, GitOptions } from '../../git';
import { OperationCancelledError, OperationLimitError, OperationTimeoutError } from '../../operations';
import { commitChanges, FileChange, mergeChanges } from '../../patch';
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

describe('commitChanges', () => {
    test('loads a single-parent commit with its subject, author, and date', async () => {
        const repo = makeRepo({ 'a.txt': 'base\n' });
        const parent = git(repo, 'rev-parse', 'HEAD').trim();
        writeFiles(repo, { 'a.txt': 'edited\n', 'b.txt': 'new\n' });
        const tip = commitAll(repo, 'Edit a and add b');

        const review = await commitChanges(gitTool, repo, 'HEAD');

        assert.equal(review.commit, tip);
        assert.equal(review.subject, 'Edit a and add b');
        assert.equal(review.author, 'View Patch Tests <tests@example.com>');
        assert.equal(review.date, git(repo, 'log', '-1', '--format=%aD', tip).trim());
        assert.deepEqual(review.parents, [parent]);
        assert.equal(review.perParent.length, 1);
        const [entry] = review.perParent;
        assert.equal(entry.parent, parent);
        assert.deepEqual([...entry.changes].sort(byNewPath).map(contentOnly), [
            { status: 'M', newPath: 'a.txt', before: 'base\n', after: 'edited\n' },
            { status: 'A', newPath: 'b.txt', before: undefined, after: 'new\n' },
        ]);
        assert.deepEqual([...entry.skipped], []);
    });

    test('reviews a merge commit entry for entry like mergeChanges', async () => {
        const { repo, main, feature } = twoParentMerge();

        const review = await commitChanges(gitTool, repo, 'HEAD');
        const merged = await mergeChanges(gitTool, repo, 'HEAD');

        assert.equal(review.commit, merged.commit);
        assert.deepEqual(review.parents, merged.parents);
        assert.deepEqual(review.parents, [main, feature]);
        assert.equal(review.perParent.length, 2);
        assert.deepEqual(review.perParent, merged.perParent);
        assert.equal(review.subject, git(repo, 'log', '-1', '--format=%s').trim());
        assert.equal(review.date, git(repo, 'log', '-1', '--format=%aD').trim());
    });

    test('reviews a root commit against a privately hashed empty tree', async () => {
        const repo = makeRepo({ 'a.txt': 'first\n', 'sub/b.txt': 'second\n' });
        const root = git(repo, 'rev-parse', 'HEAD').trim();
        // Write the empty tree into the source: a borrowed-object write would freshen this file's timestamp.
        assert.match(git(repo, 'hash-object', '-w', '-t', 'tree', '--stdin').trim(), /^[0-9a-f]{40}$/);
        const before = snapshotFiles(repo);
        const hashObjectEnvs: (Readonly<Record<string, string>> | undefined)[] = [];
        class RecordingGit extends Git {
            override run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                if (args.includes('hash-object')) {
                    hashObjectEnvs.push(options.env);
                }
                return super.run(args, options);
            }
        }
        const scratchRoot = tempDir('view-patch-commit-');

        const review = await withTempRoot(scratchRoot, () => commitChanges(new RecordingGit(), repo, root));

        assert.equal(review.commit, root);
        assert.deepEqual(review.parents, []);
        assert.equal(review.perParent.length, 1);
        const [entry] = review.perParent;
        assert.equal(entry.parent, undefined);
        assert.deepEqual([...entry.changes].sort(byNewPath).map(contentOnly), [
            { status: 'A', newPath: 'a.txt', before: undefined, after: 'first\n' },
            { status: 'A', newPath: 'sub/b.txt', before: undefined, after: 'second\n' },
        ]);
        assert.deepEqual([...entry.skipped], []);
        // The empty tree was hashed exactly once, into the private store with no borrowed alternates.
        assert.equal(hashObjectEnvs.length, 1);
        assert.equal(hashObjectEnvs[0]?.GIT_ALTERNATE_OBJECT_DIRECTORIES, '');
        assert.equal(hashObjectEnvs[0]?.GIT_OBJECT_DIRECTORY?.startsWith(scratchRoot), true);
        assert.deepEqual(snapshotFiles(repo), before);
        assert.deepEqual(readdirSync(scratchRoot), []);
    });

    test('resolves branch names, relative revisions, and short hashes to the same full hash', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const tip = commitAll(repo, 'Second commit');
        const parent = git(repo, 'rev-parse', 'HEAD~1').trim();
        const short = git(repo, 'rev-parse', '--short', tip).trim();
        assert.notEqual(short, tip);

        assert.equal((await commitChanges(gitTool, repo, 'main')).commit, tip);
        assert.equal((await commitChanges(gitTool, repo, short)).commit, tip);
        assert.equal((await commitChanges(gitTool, repo, 'HEAD~1')).commit, parent);
    });

    test('rejects empty or option-looking revisions and aborted signals before invoking Git', async () => {
        class UnreachableGit extends Git {
            override run(): Promise<Buffer> {
                throw new Error('Git must not run.');
            }
        }
        const unreachable = new UnreachableGit();
        for (const revision of ['', '--all', '-n1']) {
            await assert.rejects(commitChanges(unreachable, 'unused-repo', revision), /not a Git option/);
        }
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            commitChanges(unreachable, 'unused-repo', 'HEAD', { signal: controller.signal }),
            OperationCancelledError,
        );
    });

    test('fails with a GitError for revisions that are not commits', async () => {
        const { repo } = twoParentMerge();
        await assert.rejects(commitChanges(gitTool, repo, git(repo, 'rev-parse', 'HEAD^{tree}').trim()), GitError);
        await assert.rejects(commitChanges(gitTool, repo, 'no-such-branch'), GitError);
    });

    test('spans one content budget and one deadline across the whole call', async () => {
        const repo = makeRepo({ 'a.txt': 'base\n' });
        writeFiles(repo, { 'a.txt': 'feat\n' });
        commitAll(repo, 'Second commit');
        // The modified file loads two blobs: base\n (5 bytes) and feat\n (5 bytes).
        const review = await commitChanges(gitTool, repo, 'HEAD', { maxContentBytes: 10 });
        assert.equal(review.perParent[0].changes.length, 1);
        await assert.rejects(commitChanges(gitTool, repo, 'HEAD', { maxContentBytes: 9 }), OperationLimitError);
        await assert.rejects(commitChanges(gitTool, repo, 'HEAD', { timeoutMs: 1 }), OperationTimeoutError);
    });

    test('runs no writing command on a packed-and-loose source and leaves it untouched', async () => {
        const repo = makeRepo({ 'a.txt': 'base\n', 'b.txt': 'keep\n' });
        writeFiles(repo, { 'a.txt': 'middle\n' });
        commitAll(repo, 'Second commit');
        git(repo, 'repack', '-a', '-d', '-q');
        writeFiles(repo, { 'a.txt': 'tip\n', 'c.txt': 'loose\n' });
        commitAll(repo, 'Third commit');
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
        const scratchRoot = tempDir('view-patch-commit-');

        // The tip commit is loose while its parent's objects are packed, so the read spans both storages.
        const review = await withTempRoot(scratchRoot, () => commitChanges(new RecordingGit(), repo, 'HEAD'));

        assert.equal(review.subject, 'Third commit');
        assert.equal(review.perParent.length, 1);
        assert.deepEqual([...review.perParent[0].changes].sort(byNewPath).map(change => change.newPath),
            ['a.txt', 'c.txt']);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(readdirSync(scratchRoot), []);
        const writers = ['apply', 'write-tree', 'hash-object', 'update-index', 'read-tree'];
        for (const args of commands) {
            assert.equal(writers.some(writer => args.includes(writer)), false, `writer among: ${args.join(' ')}`);
        }
    });
});

// Mirrors merge.test.ts: byte, mode, and timestamp snapshots prove the source repository served reads only.
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
