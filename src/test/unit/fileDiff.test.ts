import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git } from '../../git';
import { OperationCancelledError, OperationTimeoutError } from '../../operations';
import { FileDiffInput, fileDiffStats, unifiedFileDiff } from '../../patch';
import { git, makeRepo, removeTempDirs, tempDir } from '../helpers';

const gitTool = new Git();

after(removeTempDirs);

class UnreachableGit extends Git {
    override run(): Promise<Buffer> {
        throw new Error('Git must not run.');
    }
}

function pair(name: string, before: string, after: string): FileDiffInput {
    return { oldPath: name, newPath: name, before: Buffer.from(before), after: Buffer.from(after) };
}

/** A full-rewrite pair big enough that diffing it cannot finish inside a one-millisecond budget. */
function largePair(): FileDiffInput {
    return pair('large.txt', 'aaaaaaaaaaaaaaa\n'.repeat(120_000), 'bbbbbbbbbbbbbbb\n'.repeat(120_000));
}

/** Checks `diff` with git apply, applies it in `repo`, and leaves the working tree for inspection. */
function applyInRepo(repo: string, diff: string): void {
    const file = path.join(tempDir('view-patch-apply-'), 'change.patch');
    writeFileSync(file, diff);
    git(repo, 'apply', '--check', file);
    git(repo, 'apply', file);
}

describe('unifiedFileDiff', () => {
    test('round-trips a modification that git apply accepts', async () => {
        const before = 'one\ntwo\nthree\n';
        const after = 'one\nTWO\nthree\n';
        const repo = makeRepo({ 'a.txt': before });
        const scratchRoot = tempDir('view-patch-free-');

        const text = await withTempRoot(scratchRoot, () =>
            unifiedFileDiff(gitTool, pair('a.txt', before, after)));

        assert.equal(text.startsWith('--- a/a.txt\n+++ b/a.txt\n@@ '), true);
        applyInRepo(repo, text);
        assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), after);
        assert.deepEqual(readdirSync(scratchRoot), []);
    });

    test('round-trips an added file under /dev/null headers', async () => {
        const content = 'hello\nworld\n';
        const repo = makeRepo({ 'keep.txt': 'k\n' });

        const text = await unifiedFileDiff(gitTool, {
            oldPath: 'docs/new.txt',
            newPath: 'docs/new.txt',
            after: Buffer.from(content),
        });

        assert.equal(text.startsWith('--- /dev/null\n+++ b/docs/new.txt\n@@ -0,0 +1,2 @@\n'), true);
        applyInRepo(repo, text);
        assert.equal(readFileSync(path.join(repo, 'docs', 'new.txt'), 'utf8'), content);
    });

    test('round-trips a deleted file under /dev/null headers', async () => {
        const content = 'one\ntwo\n';
        const repo = makeRepo({ 'gone.txt': content });

        const text = await unifiedFileDiff(gitTool, {
            oldPath: 'gone.txt',
            newPath: 'gone.txt',
            before: Buffer.from(content),
        });

        assert.equal(text.startsWith('--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n'), true);
        applyInRepo(repo, text);
        assert.equal(existsSync(path.join(repo, 'gone.txt')), false);
    });

    test('marks missing final newlines on either side so the result still applies', async () => {
        const repo = makeRepo({ 'noend.txt': 'end', 'gains.txt': 'line' });

        const losing = await unifiedFileDiff(gitTool, pair('noend.txt', 'end', 'end!'));
        assert.match(losing, /^\\ No newline at end of file$/m);
        applyInRepo(repo, losing);
        assert.equal(readFileSync(path.join(repo, 'noend.txt'), 'utf8'), 'end!');

        const gaining = await unifiedFileDiff(gitTool, pair('gains.txt', 'line', 'line\n'));
        assert.match(gaining, /^\\ No newline at end of file$/m);
        applyInRepo(repo, gaining);
        assert.equal(readFileSync(path.join(repo, 'gains.txt'), 'utf8'), 'line\n');
    });

    test('names paths containing spaces in headers git apply accepts', async () => {
        const repo = makeRepo({ 'my file.txt': 'keep\n' });

        const text = await unifiedFileDiff(gitTool, pair('my file.txt', 'keep\n', 'kept\n'));

        assert.equal(text.startsWith('--- a/my file.txt\n+++ b/my file.txt\n'), true);
        applyInRepo(repo, text);
        assert.equal(readFileSync(path.join(repo, 'my file.txt'), 'utf8'), 'kept\n');
    });

    test('refuses binary content by file name without running Git', async () => {
        const unreachable = new UnreachableGit();
        const binary = Buffer.from([0x50, 0x4b, 0x00, 0x07]);
        const named = (name: string) => (error: unknown): boolean =>
            error instanceof Error && error.name === 'Error'
            && error.message.includes(`"${name}"`) && /not copyable text/.test(error.message);
        await assert.rejects(
            unifiedFileDiff(unreachable, {
                oldPath: 'old.bin', newPath: 'new.bin', before: binary, after: Buffer.from('text\n'),
            }),
            named('old.bin'),
        );
        await assert.rejects(
            unifiedFileDiff(unreachable, {
                oldPath: 'old.bin', newPath: 'new.bin', before: Buffer.from('text\n'), after: binary,
            }),
            named('new.bin'),
        );
    });

    test('returns empty text for identical sides and refuses a pair with no content at all', async () => {
        const same = Buffer.from('same\n');
        assert.equal(await unifiedFileDiff(gitTool, {
            oldPath: 'a.txt', newPath: 'a.txt', before: same, after: same,
        }), '');
        await assert.rejects(
            unifiedFileDiff(new UnreachableGit(), { oldPath: 'x.txt', newPath: 'x.txt' }),
            /no content on either side/,
        );
    });

    test('propagates cancellation and the time budget', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            unifiedFileDiff(new UnreachableGit(), pair('a.txt', 'x\n', 'y\n'), { signal: controller.signal }),
            OperationCancelledError,
        );
        await assert.rejects(
            unifiedFileDiff(gitTool, largePair(), { timeoutMs: 1 }),
            OperationTimeoutError,
        );
    });
});

describe('fileDiffStats', () => {
    test('counts every pair in order and matches independent git numstat ground truth', async () => {
        const files: FileDiffInput[] = [
            pair('m.txt', 'one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n'),
            { oldPath: 'added.txt', newPath: 'added.txt', after: Buffer.from('a\nb\n') },
            { oldPath: 'gone.txt', newPath: 'gone.txt', before: Buffer.from('x\ny\nz\n') },
            pair('same.txt', 'same\n', 'same\n'),
            { oldPath: 'img.bin', newPath: 'img.bin', before: Buffer.from([0x00, 0x01]), after: Buffer.from('t\n') },
            pair('no end.txt', 'one\ntwo\nthree\n', 'one\ntwo'),
        ];

        const stats = await fileDiffStats(gitTool, files);

        const expected = files.map((file, index) =>
            index === 4 ? undefined : numstatTruth(file.before, file.after));
        // Distinct counts per entry prove the order; spot-check the ground truth itself.
        assert.deepEqual(expected[0], { insertions: 2, deletions: 1 });
        assert.deepEqual(expected[5], { insertions: 1, deletions: 2 });
        assert.deepEqual(stats, expected);
    });

    test('returns undefined for binary content on either side without running Git', async () => {
        const binary = Buffer.from([0x00, 0x42]);
        const stats = await fileDiffStats(new UnreachableGit(), [
            { oldPath: 'a.bin', newPath: 'a.bin', before: binary, after: Buffer.from('t\n') },
            { oldPath: 'b.bin', newPath: 'b.bin', before: Buffer.from('t\n'), after: binary },
        ]);
        assert.deepEqual(stats, [undefined, undefined]);
    });

    test('returns an empty list for no files without running Git', async () => {
        assert.deepEqual(await fileDiffStats(new UnreachableGit(), []), []);
    });

    test('shares one deadline across the batch: a tiny budget fails with a typed timeout', async () => {
        await assert.rejects(
            fileDiffStats(gitTool, [largePair(), pair('b.txt', 'y\n', 'z\n')], { timeoutMs: 1 }),
            OperationTimeoutError,
        );
    });

    test('rejects an aborted signal before invoking Git', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            fileDiffStats(new UnreachableGit(), [pair('a.txt', 'x\n', 'y\n')], { signal: controller.signal }),
            OperationCancelledError,
        );
    });
});

/** Line counts straight from `git diff --no-index --numstat` over files this test writes itself. */
function numstatTruth(before: Buffer | undefined, after: Buffer | undefined): {
    insertions: number;
    deletions: number;
} {
    const dir = tempDir('view-patch-truth-');
    const left = path.join(dir, 'left');
    const right = path.join(dir, 'right');
    writeFileSync(left, before ?? Buffer.alloc(0));
    writeFileSync(right, after ?? Buffer.alloc(0));
    let output: string;
    try {
        output = execFileSync('git', ['diff', '--no-index', '--numstat', '--', left, right],
            { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        const failure = error as { status?: number; stdout?: string };
        if (failure.status !== 1 || typeof failure.stdout !== 'string') {
            throw error;
        }
        output = failure.stdout;
    }
    const counts = /^(\d+)\t(\d+)\t/.exec(output);
    return counts
        ? { insertions: Number(counts[1]), deletions: Number(counts[2]) }
        : { insertions: 0, deletions: 0 };
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
