import * as assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError, GitOptions } from '../../git';
import { OperationCancelledError, OperationLimitError, OperationTimeoutError } from '../../operations';
import { applyPatch, FileChange, isBinary, looksLikePatch, parseRawDiff, patchCommit } from '../../patch';
import { parentOf } from '../../repositories';
import { commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const gitTool = new Git();
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

after(removeTempDirs);

const byNewPath = (a: FileChange, b: FileChange): number => a.newPath.localeCompare(b.newPath);

// An expected FileChange; each side is text or bytes, or undefined when the side does not exist.
function change(status: string, oldPath: string, newPath: string, before?: string | Buffer, after?: string | Buffer) {
    const bytes = (side?: string | Buffer) => (side === undefined ? undefined : Buffer.from(side));
    return { status, oldPath, newPath, before: bytes(before), after: bytes(after) };
}

function contentOnly({ status, oldPath, newPath, before, after }: FileChange): FileChange {
    return { status, oldPath, newPath, before, after };
}

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

class InspectingGit extends Git {
    readonly scratchFolders = new Set<string>();
    readonly writtenTrees: string[] = [];

    override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
        const index = options.env?.GIT_INDEX_FILE;
        if (index) {
            this.scratchFolders.add(path.dirname(index));
        }
        const output = await super.run(args, options);
        if (args.includes('write-tree')) {
            this.writtenTrees.push(output.toString('utf8').trim());
        }
        return output;
    }
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
        assert.equal(patchCommit('commit 0123456\n'), '0123456');
        assert.equal(patchCommit('commit 012345\n'), undefined);
    });

    test('ignores other first lines and later lines', () => {
        assert.equal(patchCommit('diff --git a/x b/x\n'), undefined);
        assert.equal(patchCommit('From: Someone <a@example.com>\n'), undefined);
        assert.equal(patchCommit(`\nFrom ${COMMIT} Mon Sep 17 00:00:00 2001\n`), undefined);
    });

    test('does not treat a cover letter hash as a commit', () => {
        assert.equal(patchCommit(`From ${'0'.repeat(40)} Mon Sep 17 00:00:00 2001\n`), undefined);
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

    test('rejects malformed or truncated records', () => {
        assert.throws(() => parseRawDiff(Buffer.from(':100644 broken\0a.txt\0')), /malformed raw diff/);
        assert.throws(() => parseRawDiff(Buffer.from(':100644 100644 aaa bbb M\0')), /truncated raw diff/);
        assert.throws(() => parseRawDiff(Buffer.from(':100644 100644 aaa bbb R100\0old\0')), /truncated raw diff/);
        assert.throws(() => parseRawDiff(Buffer.from(':100644 100644 aaa bbb M\0a.txt')), /truncated raw diff/);
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
            'logo.bin': Buffer.from([0, 1, 2, 4, 255]),
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

        assert.deepEqual(applied.changes.map(contentOnly).sort(byNewPath), [
            change('M', 'debug.log', 'debug.log', 'log 1\n', 'log 2\n'),
            change('D', 'gone.txt', 'gone.txt', 'bye\n', undefined),
            change('M', 'logo.bin', 'logo.bin', Buffer.from([0, 1, 2, 3, 255]), Buffer.from([0, 1, 2, 4, 255])),
            change('R', 'old/name.txt', 'moved/name2.txt', lines, lines.replace('line 20', 'line twenty')),
            change('A', 'new/trace.log', 'new/trace.log', undefined, 'trace\n'),
            change('M', 'src/main.c', 'src/main.c', 'int main(void) { return 0; }\n', 'int main(void) { return 1; }\n'),
        ]);
        const skipped = applied.skipped.map(({ reason, oldPath, newPath }) => ({ reason, oldPath, newPath }));
        assert.deepEqual(skipped.sort((a, b) => a.reason.localeCompare(b.reason)), [
            { reason: 'mode', oldPath: 'run.sh', newPath: 'run.sh' },
            { reason: 'rename', oldPath: 'pure/a.txt', newPath: 'pure/b.txt' },
            { reason: 'submodule', oldPath: 'vendor/lib', newPath: 'vendor/lib' },
        ]);
        for (const entry of [...applied.changes, ...applied.skipped]) {
            assert.match(entry.oldId ?? '', /^[0-9a-f]{40}$/);
            assert.match(entry.newId ?? '', /^[0-9a-f]{40}$/);
            assert.match(entry.oldMode ?? '', /^[0-7]{6}$/);
            assert.match(entry.newMode ?? '', /^[0-7]{6}$/);
        }
        const binary = applied.changes.find(entry => entry.newPath === 'logo.bin');
        assert.equal(binary?.before?.length, binary?.after?.length);
        assert.notEqual(binary?.oldId, binary?.newId);
        const mode = applied.skipped.find(entry => entry.reason === 'mode');
        assert.equal(mode?.oldMode, '100644');
        assert.equal(mode?.newMode, '100755');
        assert.equal(mode?.oldId, mode?.newId);
        const renamed = applied.skipped.find(entry => entry.reason === 'rename');
        assert.equal(renamed?.oldId, renamed?.newId);
        const submodule = applied.skipped.find(entry => entry.reason === 'submodule');
        assert.equal(submodule?.oldMode, '000000');
        assert.equal(submodule?.newMode, '160000');
        assert.equal(submodule?.newId, git(repo, 'rev-parse', `${commit}^`).trim());
    });

    test('never writes to the repository and removes its scratch folder', async () => {
        const { repo, commit } = mixedCommit();
        // A diff of an uncommitted edit: no object holds its new content yet, so applying it must store one.
        writeFiles(repo, { 'src/main.c': 'int main(void) { return 2; }\n' });
        const unstored = Buffer.from(git(repo, 'diff', '--', 'src/main.c'));
        git(repo, 'checkout', '--', 'src/main.c');
        const snapshot = () => ({
            status: git(repo, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
            objects: git(repo, 'count-objects', '-v'),
            refs: git(repo, 'show-ref'),
            files: snapshotFiles(repo),
        });
        const before = snapshot();
        const scratchRoot = tempDir('view-patch-scratch-');
        const inspected = new InspectingGit();

        const applied = await withTempRoot(scratchRoot, () => applyPatch(inspected, repo, 'HEAD', unstored));
        assert.equal(applied.changes[0]?.after?.toString(), 'int main(void) { return 2; }\n');
        await withTempRoot(scratchRoot, () =>
            applyPatch(gitTool, repo, `${commit}^`, Buffer.from(formatPatch(repo, commit))),
        );
        await withTempRoot(scratchRoot, () =>
            assert.rejects(applyPatch(gitTool, repo, commit, Buffer.from(formatPatch(repo, commit))), GitError),
        );

        assert.deepEqual(snapshot(), before);
        assert.deepEqual(readdirSync(scratchRoot), []);
        for (const folder of inspected.scratchFolders) {
            assert.equal(existsSync(folder), false);
        }
        for (const tree of inspected.writtenTrees) {
            assert.equal(await gitTool.succeeds(['cat-file', '-e', tree], { cwd: repo }), false);
        }
        assert.equal(await gitTool.succeeds(['cat-file', '-e', applied.changes[0]?.newId ?? ''], { cwd: repo }), false);
    });

    test('does not freshen packed source objects when the applied result already exists there', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const commit = commitAll(repo, 'Packed update');
        git(repo, 'gc', '--prune=now');
        const patch = Buffer.from(formatPatch(repo, commit));
        const before = snapshotFiles(repo);

        const applied = await applyPatch(gitTool, repo, `${commit}^`, patch);

        assert.equal(applied.changes[0]?.after?.toString(), 'two\n');
        assert.deepEqual(snapshotFiles(repo), before);
    });

    test('retains identifiers and modes for modified and deleted submodule pointers', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        const first = git(repo, 'rev-parse', 'HEAD').trim();
        git(repo, 'update-index', '--add', '--cacheinfo', `160000,${first},modules/example`);
        git(repo, 'commit', '-q', '-m', 'Add module pointer');
        const base = git(repo, 'rev-parse', 'HEAD').trim();
        git(repo, 'update-index', '--cacheinfo', `160000,${base},modules/example`);
        git(repo, 'commit', '-q', '-m', 'Update module pointer');
        const updated = git(repo, 'rev-parse', 'HEAD').trim();
        const modified = await applyPatch(gitTool, repo, base, Buffer.from(formatPatch(repo, updated)));
        assert.equal(modified.changes.length, 0);
        assert.deepEqual(modified.skipped, [{
            reason: 'submodule',
            oldPath: 'modules/example',
            newPath: 'modules/example',
            oldId: first,
            newId: base,
            oldMode: '160000',
            newMode: '160000',
        }]);
        git(repo, 'update-index', '--force-remove', 'modules/example');
        git(repo, 'commit', '-q', '-m', 'Remove module pointer');
        const deleted = await applyPatch(gitTool, repo, updated, Buffer.from(formatPatch(repo)));
        assert.equal(deleted.skipped[0]?.oldId, base);
        assert.equal(deleted.skipped[0]?.newId, '0'.repeat(40));
        assert.equal(deleted.skipped[0]?.oldMode, '160000');
        assert.equal(deleted.skipped[0]?.newMode, '000000');
    });

    test('still applies a plain unified diff without Git object headers', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        const patch = Buffer.from('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n');
        const applied = await applyPatch(gitTool, repo, 'HEAD', patch);
        assert.deepEqual(applied.changes.map(contentOnly), [change('M', 'a.txt', 'a.txt', 'one\n', 'two\n')]);
        assert.equal(applied.parts?.length, 1);
        assert.deepEqual(applied.metadata, {});
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
        assert.deepEqual(
            applied.changes.map(contentOnly),
            [change('A', 'readme.md', 'readme.md', undefined, '# Hello\n')],
        );
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

    test('preserves literal pathspec characters, tabs, and newlines', {
        skip: process.platform === 'win32',
    }, async () => {
        const names = ['literal[1].txt', 'tab\tname.txt', 'line\nname.txt'];
        const repo = makeRepo(Object.fromEntries(names.map(name => [name, 'one\n'])));
        writeFiles(repo, Object.fromEntries(names.map(name => [name, 'two\n'])));
        const commit = commitAll(repo, 'Update unusual names');
        const applied = await applyPatch(gitTool, repo, `${commit}^`, Buffer.from(formatPatch(repo, commit)));
        assert.deepEqual(applied.changes.map(entry => entry.newPath).sort(), [...names].sort());
        assert.ok(applied.changes.every(entry => entry.before?.toString() === 'one\n'));
        assert.ok(applied.changes.every(entry => entry.after?.toString() === 'two\n'));
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

    test('preserves dirty linked worktrees, split indexes, ignored files, refs, and source objects', async () => {
        const repo = makeRepo({ '.gitignore': '*.log\n', 'a.txt': 'one\n', 'other.txt': 'clean\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const commit = commitAll(repo, 'Change a file');
        const linked = path.join(tempDir(), 'linked');
        git(repo, 'worktree', 'add', '-q', '--detach', linked, `${commit}^`);
        writeFiles(linked, {
            'a.txt': 'local unstaged edit\n',
            'other.txt': 'staged edit\n',
            'untracked.txt': 'untracked\n',
            'ignored.log': 'ignored\n',
        });
        git(linked, 'add', 'other.txt');
        writeFiles(linked, { 'other.txt': 'another unstaged edit\n' });
        git(repo, 'config', 'core.splitIndex', 'true');
        git(repo, 'config', 'core.untrackedCache', 'true');
        git(repo, 'config', 'core.sparseCheckout', 'true');
        git(linked, 'update-index', '--split-index');
        const before = { source: snapshotFiles(repo), linked: snapshotFiles(linked) };

        const applied = await applyPatch(gitTool, linked, 'HEAD', Buffer.from(formatPatch(repo, commit)));

        assert.deepEqual(applied.changes.map(contentOnly), [change('M', 'a.txt', 'a.txt', 'one\n', 'two\n')]);
        assert.deepEqual({ source: snapshotFiles(repo), linked: snapshotFiles(linked) }, before);
    });

    test('freezes the tree before a moving HEAD can change later snapshots', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        const initial = git(repo, 'rev-parse', 'HEAD').trim();
        const initialTree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
        writeFiles(repo, { 'a.txt': 'two\n' });
        const next = commitAll(repo, 'Next value');
        const patch = Buffer.from(formatPatch(repo, next));
        git(repo, 'update-ref', 'HEAD', initial);
        let readTree: string | undefined;
        class MovingGit extends Git {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                const index = args.indexOf('read-tree');
                if (index >= 0) {
                    readTree = args[index + 1];
                    git(repo, 'update-ref', 'HEAD', next);
                }
                return super.run(args, options);
            }
        }

        const applied = await applyPatch(new MovingGit(), repo, 'HEAD', patch);

        assert.equal(readTree, initialTree);
        assert.equal(applied.baseTree, initialTree);
        assert.deepEqual(applied.changes.map(contentOnly), [change('M', 'a.txt', 'a.txt', 'one\n', 'two\n')]);
    });

    test('accepts an exact patch-byte limit and rejects an excess before running Git', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const patch = Buffer.from(git(repo, 'diff'));
        class UnreachableGit extends Git {
            override run(): Promise<Buffer> {
                throw new Error('Git must not run.');
            }
        }
        await assert.rejects(
            applyPatch(new UnreachableGit(), repo, 'HEAD', patch, { maxPatchBytes: patch.length - 1 }),
            OperationLimitError,
        );
        const applied = await applyPatch(gitTool, repo, 'HEAD', patch, { maxPatchBytes: patch.length });
        assert.equal(applied.changes[0]?.after?.toString(), 'two\n');
    });

    test('counts exact unique blob bytes, not repeated paths, and preflights before loading bodies', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n', 'b.txt': 'two\n' });
        const patch = Buffer.from(git(repo, 'diff'));
        const applied = await applyPatch(gitTool, repo, 'HEAD', patch, { maxContentBytes: 8 });
        assert.equal(applied.changes.length, 2);
        assert.equal(applied.changes[0].before, applied.changes[1].before);
        assert.equal(applied.changes[0].after, applied.changes[1].after);
        await assert.rejects(
            applyPatch(gitTool, repo, 'HEAD', patch, { maxContentBytes: 7 }),
            OperationLimitError,
        );
        let loadedBodies = false;
        class CountingGit extends Git {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                loadedBodies ||= args.includes('--batch');
                return super.run(args, options);
            }
        }
        const scratchRoot = tempDir('view-patch-limits-');
        await withTempRoot(scratchRoot, () => assert.rejects(
            applyPatch(new CountingGit(), repo, 'HEAD', patch, { maxContentBytes: 3 }),
            OperationLimitError,
        ));
        assert.equal(loadedBodies, false);
        assert.deepEqual(readdirSync(scratchRoot), []);
    });

    test('distinguishes empty content from an absent side at an exact byte budget', async () => {
        const repo = makeRepo({ 'a.txt': '' });
        writeFiles(repo, { 'a.txt': 'x' });
        const patch = Buffer.from(git(repo, 'diff'));
        const applied = await applyPatch(gitTool, repo, 'HEAD', patch, { maxContentBytes: 1 });
        assert.deepEqual(applied.changes[0]?.before, Buffer.alloc(0));
        assert.deepEqual(applied.changes[0]?.after, Buffer.from('x'));
    });

    test('rejects invalid limits before invoking Git', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        for (const options of [
            { maxPatchBytes: 0 }, { maxContentBytes: -1 }, { maxOutputBytes: 1.5 }, { timeoutMs: Infinity },
        ]) {
            await assert.rejects(
                applyPatch(gitTool, repo, 'HEAD', Buffer.alloc(0), options),
                /must be a positive whole number/,
            );
        }
    });

    test('rejects an already-aborted operation before invoking Git', async () => {
        const controller = new AbortController();
        controller.abort();
        class UnreachableGit extends Git {
            override run(): Promise<Buffer> {
                throw new Error('Git must not run.');
            }
        }
        await assert.rejects(
            applyPatch(new UnreachableGit(), '', 'HEAD', Buffer.alloc(0), { signal: controller.signal }),
            OperationCancelledError,
        );
    });

    test('cleans its private index and objects when cancelled between phases', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const patch = Buffer.from(git(repo, 'diff'));
        const before = snapshotFiles(repo);
        const controller = new AbortController();
        class CancellingGit extends InspectingGit {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                const result = await super.run(args, options);
                if (args.includes('apply') && args.includes('--cached')) {
                    controller.abort();
                }
                return result;
            }
        }
        const tool = new CancellingGit();
        const scratchRoot = tempDir('view-patch-cancel-');
        await withTempRoot(scratchRoot, () => assert.rejects(
            applyPatch(tool, repo, 'HEAD', patch, { signal: controller.signal }),
            OperationCancelledError,
        ));
        assert.equal(tool.scratchFolders.size, 1);
        assert.deepEqual(readdirSync(scratchRoot), []);
        assert.deepEqual(snapshotFiles(repo), before);
    });

    test('enforces a shared operation deadline and removes files after timeout', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const patch = Buffer.from(git(repo, 'diff'));
        class SlowGit extends InspectingGit {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                const result = await super.run(args, options);
                if (args.includes('read-tree')) {
                    await new Promise(resolve => setTimeout(resolve, (options.timeoutMs ?? 250) + 10));
                }
                return result;
            }
        }
        const scratchRoot = tempDir('view-patch-timeout-');
        await withTempRoot(scratchRoot, () => assert.rejects(
            applyPatch(new SlowGit(), repo, 'HEAD', patch, { timeoutMs: 250 }),
            (error: unknown) => error instanceof OperationTimeoutError && error.timeoutMs === 250,
        ));
        assert.deepEqual(readdirSync(scratchRoot), []);
    });

    test('bounds command output and removes scratch files on a limit failure', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const patch = Buffer.from(git(repo, 'diff'));
        const before = snapshotFiles(repo);
        const scratchRoot = tempDir('view-patch-output-');
        await withTempRoot(scratchRoot, () => assert.rejects(
            applyPatch(gitTool, repo, 'HEAD', patch, { maxOutputBytes: 100 }),
            OperationLimitError,
        ));
        assert.deepEqual(readdirSync(scratchRoot), []);
        assert.deepEqual(snapshotFiles(repo), before);
    });

    test('refuses a base that looks like an option', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        await assert.rejects(applyPatch(gitTool, repo, '--output=x', Buffer.alloc(0)), /is not a revision/);
    });
});

describe('blob response validation', () => {
    type Corrupt = (output: Buffer, id: string) => Buffer;
    const replaceHeader = (output: Buffer, header: string): Buffer =>
        Buffer.concat([Buffer.from(`${header}\n`), output.subarray(output.indexOf(0x0a) + 1)]);
    const cases: readonly [string, Corrupt, RegExp][] = [
        ['missing object', (_output, id) => Buffer.from(`${id} missing\n`), /missing object/],
        ['missing header newline', () => Buffer.from('not a header'), /truncated header/],
        ['wrong object', (output) => replaceHeader(output, `${COMMIT} blob 4`), /malformed blob header/],
        ['wrong object type', (output, id) => replaceHeader(output, `${id} tree 4`), /malformed blob header/],
        ['negative size', (output, id) => replaceHeader(output, `${id} blob -1`), /malformed blob header/],
        ['fractional size', (output, id) => replaceHeader(output, `${id} blob 1.5`), /malformed blob header/],
        ['non-numeric size', (output, id) => replaceHeader(output, `${id} blob NaN`), /malformed blob header/],
        ['unsafe size', (output, id) => replaceHeader(output, `${id} blob 9007199254740992`), /invalid blob size/],
        ['inconsistent size', (output, id) => replaceHeader(output, `${id} blob 5`), /inconsistent size/],
        ['truncated body', output => output.subarray(0, output.length - 2), /truncated body/],
        ['missing body terminator', output => output.subarray(0, output.length - 1), /missing terminator/],
        ['same-size corrupt body', output => {
            const corrupted = Buffer.from(output);
            corrupted[corrupted.indexOf(0x0a) + 1] ^= 1;
            return corrupted;
        }, /does not match blob/],
        ['trailing data', output => Buffer.concat([output, Buffer.from('extra')]), /unexpected data/],
    ];
    for (const [name, corrupt, expected] of cases) {
        test(name, async () => {
            const repo = makeRepo({ 'a.txt': 'one\n' });
            writeFiles(repo, { 'a.txt': 'two\n' });
            const patch = Buffer.from(git(repo, 'diff'));
            class BrokenGit extends Git {
                override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                    const output = await super.run(args, options);
                    return args.includes('--batch')
                        ? corrupt(output, output.toString('utf8', 0, output.indexOf(0x20)))
                        : output;
                }
            }
            const scratchRoot = tempDir('view-patch-broken-');
            await withTempRoot(scratchRoot, () =>
                assert.rejects(applyPatch(new BrokenGit(), repo, 'HEAD', patch), expected));
            assert.deepEqual(readdirSync(scratchRoot), []);
        });
    }

    test('rejects malformed preflight sizes before requesting blob bodies', async () => {
        const repo = makeRepo({ 'a.txt': 'one\n' });
        writeFiles(repo, { 'a.txt': 'two\n' });
        const patch = Buffer.from(git(repo, 'diff'));
        let loadedBodies = false;
        class BrokenGit extends Git {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                loadedBodies ||= args.includes('--batch');
                const output = await super.run(args, options);
                return args.some(arg => arg.startsWith('--batch-check='))
                    ? Buffer.from(output.toString('utf8').replace(/ blob \d+\n/, ' blob -1\n'))
                    : output;
            }
        }
        await assert.rejects(applyPatch(new BrokenGit(), repo, 'HEAD', patch), /malformed blob header/);
        assert.equal(loadedBodies, false);
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
