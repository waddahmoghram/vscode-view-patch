import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError } from '../../git';
import { applyPatch, FileChange, isBinary, looksLikePatch, parseRawDiff, patchCommit } from '../../patch';
import { parentOf } from '../../repositories';
import { commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const gitTool = new Git();
const COMMIT = '34d23709baff4babc7bb91d78deb2658e1233e8a';

after(removeTempDirs);

const byNewPath = (a: FileChange, b: FileChange): number => a.newPath.localeCompare(b.newPath);

// An expected FileChange; each side is text or bytes, or undefined when the side does not exist.
function change(status: string, oldPath: string, newPath: string, before?: string | Buffer, after?: string | Buffer) {
    const bytes = (side?: string | Buffer) => (side === undefined ? undefined : Buffer.from(side));
    return { status, oldPath, newPath, before: bytes(before), after: bytes(after) };
}

describe('patchCommit', () => {
    test('reads the commit from the first line of a git format-patch file', () => {
        assert.equal(patchCommit(`From ${COMMIT} Mon Sep 17 00:00:00 2001\nFrom: A <a@example.com>\n`), COMMIT);
    });

    test('reads the commit from git show output, with or without decorations', () => {
        assert.equal(patchCommit(`commit ${COMMIT}\nAuthor: A\n`), COMMIT);
        assert.equal(patchCommit(`commit ${COMMIT} (HEAD -> main)\r\n`), COMMIT);
    });

    test('accepts an abbreviated commit of seven or more digits', () => {
        assert.equal(patchCommit('commit 34d2370\n'), '34d2370');
        assert.equal(patchCommit('commit 34d237\n'), undefined);
    });

    test('ignores other first lines and later lines', () => {
        assert.equal(patchCommit('diff --git a/x b/x\n'), undefined);
        assert.equal(patchCommit('From: Someone <a@example.com>\n'), undefined);
        assert.equal(patchCommit(`\nFrom ${COMMIT} Mon Sep 17 00:00:00 2001\n`), undefined);
    });
});

describe('looksLikePatch', () => {
    test('accepts Git diffs and plain unified diffs', () => {
        assert.equal(looksLikePatch('diff --git a/x b/x\n'), true);
        assert.equal(looksLikePatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n'), true);
        assert.equal(looksLikePatch('--- a/x\r\n+++ b/x\r\n'), true);
    });

    test('refuses other text', () => {
        assert.equal(looksLikePatch('Just some notes\n--- not a header\n'), false);
        assert.equal(looksLikePatch(''), false);
    });
});

describe('isBinary', () => {
    test('treats a NUL byte near the start as binary', () => {
        assert.equal(isBinary(Buffer.from([65, 0, 66])), true);
        assert.equal(isBinary(Buffer.from('plain text\n')), false);
        assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 65), Buffer.from([0])])), false);
    });
});

describe('parseRawDiff', () => {
    test('reads modified, added, deleted, and renamed records', () => {
        const raw = Buffer.from(
            [
                ':100644 100644 aaa bbb M', 'src/a b.c',
                ':000000 100644 000 ccc A', 'new.txt',
                ':100644 000000 ddd 000 D', 'gone.txt',
                ':100644 100644 eee fff R087', 'old/name.txt', 'moved/name.txt',
                '',
            ].join('\0'),
        );
        const record = (meta: string, oldPath: string, newPath = oldPath) => {
            const [oldMode, newMode, oldId, newId, status] = meta.split(' ');
            return { oldMode, newMode, oldId, newId, status, oldPath, newPath };
        };
        assert.deepEqual(parseRawDiff(raw), [
            record('100644 100644 aaa bbb M', 'src/a b.c'),
            record('000000 100644 000 ccc A', 'new.txt'),
            record('100644 000000 ddd 000 D', 'gone.txt'),
            record('100644 100644 eee fff R087', 'old/name.txt', 'moved/name.txt'),
        ]);
    });

    test('returns nothing for empty output', () => {
        assert.deepEqual(parseRawDiff(Buffer.alloc(0)), []);
    });
});

describe('applyPatch', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join('');

    // One commit that edits, adds, deletes, renames with and without edits, changes a binary file, touches files that
    // .gitignore ignores, flips a mode, and adds a submodule pointer.
    function mixedCommit(): { repo: string; commit: string } {
        const repo = makeRepo({
            '.gitignore': '*.log\n',
            'debug.log': 'log 1\n',
            'src/main.c': 'int main(void) { return 0; }\n',
            'gone.txt': 'bye\n',
            'old/name.txt': lines,
            'pure/a.txt': 'same\n',
            'run.sh': 'echo hi\n',
            'logo.bin': Buffer.from([0, 1, 2, 3, 255]),
        });
        const first = git(repo, 'rev-parse', 'HEAD').trim();
        writeFiles(repo, {
            'debug.log': 'log 2\n',
            'new/trace.log': 'trace\n',
            'src/main.c': 'int main(void) { return 1; }\n',
            'gone.txt': null,
            'old/name.txt': null,
            'moved/name2.txt': lines.replace('line 20', 'line twenty'),
            'pure/a.txt': null,
            'pure/b.txt': 'same\n',
            'logo.bin': Buffer.from([0, 1, 2, 4, 255, 7]),
        });
        git(repo, 'add', '-A', '-f');
        git(repo, 'update-index', '--chmod=+x', 'run.sh');
        git(repo, 'update-index', '--add', '--cacheinfo', `160000,${first},vendor/lib`);
        git(repo, 'commit', '-q', '-m', 'Mixed change');
        return { repo, commit: git(repo, 'rev-parse', 'HEAD').trim() };
    }

    test('returns both sides of every content change and lists the changes without one', async () => {
        const { repo, commit } = mixedCommit();
        const applied = await applyPatch(gitTool, repo, `${commit}^`, Buffer.from(formatPatch(repo, commit)));

        assert.deepEqual([...applied.changes].sort(byNewPath), [
            change('M', 'debug.log', 'debug.log', 'log 1\n', 'log 2\n'),
            change('D', 'gone.txt', 'gone.txt', 'bye\n', undefined),
            change('M', 'logo.bin', 'logo.bin', Buffer.from([0, 1, 2, 3, 255]), Buffer.from([0, 1, 2, 4, 255, 7])),
            change('R', 'old/name.txt', 'moved/name2.txt', lines, lines.replace('line 20', 'line twenty')),
            change('A', 'new/trace.log', 'new/trace.log', undefined, 'trace\n'),
            change('M', 'src/main.c', 'src/main.c', 'int main(void) { return 0; }\n', 'int main(void) { return 1; }\n'),
        ]);
        assert.deepEqual([...applied.skipped].sort((a, b) => a.reason.localeCompare(b.reason)), [
            { reason: 'mode', oldPath: 'run.sh', newPath: 'run.sh' },
            { reason: 'rename', oldPath: 'pure/a.txt', newPath: 'pure/b.txt' },
            { reason: 'submodule', oldPath: 'vendor/lib', newPath: 'vendor/lib' },
        ]);
    });

    test('never writes to the repository and removes its scratch folder', async () => {
        const { repo, commit } = mixedCommit();
        // A diff of an uncommitted edit: no object holds its new content yet, so applying it must store one.
        writeFiles(repo, { 'src/main.c': 'int main(void) { return 2; }\n' });
        const unstored = Buffer.from(git(repo, 'diff', '--', 'src/main.c'));
        git(repo, 'checkout', '--', 'src/main.c');
        const snapshot = () => ({
            index: readFileSync(path.join(repo, '.git', 'index')).toString('base64'),
            status: git(repo, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
            objects: git(repo, 'count-objects', '-v'),
            refs: git(repo, 'show-ref'),
        });
        const before = snapshot();
        const scratchRoot = tempDir('view-patch-scratch-');

        const applied = await withTempRoot(scratchRoot, () => applyPatch(gitTool, repo, 'HEAD', unstored));
        assert.equal(applied.changes[0]?.after?.toString(), 'int main(void) { return 2; }\n');
        await withTempRoot(scratchRoot, () =>
            applyPatch(gitTool, repo, `${commit}^`, Buffer.from(formatPatch(repo, commit))),
        );
        await withTempRoot(scratchRoot, () =>
            assert.rejects(applyPatch(gitTool, repo, commit, Buffer.from(formatPatch(repo, commit))), GitError),
        );

        assert.deepEqual(snapshot(), before);
        assert.deepEqual(readdirSync(scratchRoot), []);
    });

    test('reports why a patch does not apply', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n';
        await assert.rejects(
            applyPatch(gitTool, repo, 'HEAD', Buffer.from(patch)),
            (error: unknown) => error instanceof GitError && /patch does not apply/.test(error.message),
        );
    });

    test('applies a first commit on the empty tree', async () => {
        const repo = makeRepo({ 'readme.md': '# Hello\n' });
        const commit = git(repo, 'rev-parse', 'HEAD').trim();
        const base = await parentOf(gitTool, repo, commit);
        assert.match(base, /^[0-9a-f]{40}$/);

        const applied = await applyPatch(gitTool, repo, base, Buffer.from(formatPatch(repo, commit)));
        assert.deepEqual(applied.changes, [change('A', 'readme.md', 'readme.md', undefined, '# Hello\n')]);
    });

    test('keeps file names with spaces and non-ASCII letters', async () => {
        const repo = makeRepo({ 'docs/naïve notes.md': 'one\n' });
        writeFiles(repo, { 'docs/naïve notes.md': 'two\n' });
        const commit = commitAll(repo, 'Edit notes');

        const applied = await applyPatch(gitTool, repo, `${commit}^`, Buffer.from(formatPatch(repo, commit)));
        assert.deepEqual(
            applied.changes.map(change => change.newPath),
            ['docs/naïve notes.md'],
        );
    });

    test('works in a linked worktree, whose objects live in the main repository', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const commit = commitAll(repo, 'Second');
        const linked = path.join(tempDir(), 'linked');
        git(repo, 'worktree', 'add', '-q', '--detach', linked, `${commit}^`);

        const applied = await applyPatch(gitTool, linked, 'HEAD', Buffer.from(formatPatch(repo, commit)));
        assert.deepEqual(
            applied.changes.map(change => [change.before?.toString(), change.after?.toString()]),
            [['one\n', 'two\n']],
        );
    });

    test('refuses a base that looks like an option', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        await assert.rejects(applyPatch(gitTool, repo, '--output=x', Buffer.alloc(0)), /is not a revision/);
    });
});

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
