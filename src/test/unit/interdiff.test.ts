import * as assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError, GitOptions } from '../../git';
import { OperationCancelledError, OperationLimitError } from '../../operations';
import { compareApplied, FileChange } from '../../patch';
import { commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const gitTool = new Git();

after(removeTempDirs);

// Two patch versions of the same change: v1 answers 42 and v2 answers 43, both against the same base commit.
function versions(): { repo: string; base: string; v1: Buffer; v2: Buffer } {
    const repo = makeRepo({ 'answer.txt': 'question\n' });
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    writeFiles(repo, { 'answer.txt': '42\n' });
    const v1 = Buffer.from(formatPatch(repo, commitAll(repo, 'Answer v1')));
    git(repo, 'reset', '-q', '--hard', base);
    writeFiles(repo, { 'answer.txt': '43\n' });
    const v2 = Buffer.from(formatPatch(repo, commitAll(repo, 'Answer v2')));
    git(repo, 'reset', '-q', '--hard', base);
    return { repo, base, v1, v2 };
}

function contentOnly({ status, oldPath, newPath, before, after: result }: FileChange) {
    return { status, oldPath, newPath, before: before?.toString(), after: result?.toString() };
}

describe('compareApplied', () => {
    test('shows what changed between two versions applied on the same frozen base', async () => {
        const { repo, base, v1, v2 } = versions();

        const comparison = await compareApplied(gitTool, repo, base, v1, v2);

        assert.equal(comparison.base, base);
        assert.equal(comparison.baseTree, git(repo, 'rev-parse', `${base}^{tree}`).trim());
        assert.deepEqual(comparison.changes.map(contentOnly), [
            { status: 'M', oldPath: 'answer.txt', newPath: 'answer.txt', before: '42\n', after: '43\n' },
        ]);
        assert.deepEqual(comparison.skipped, []);
        for (const [version, text] of [[comparison.first, '42\n'], [comparison.second, '43\n']] as const) {
            assert.equal(version.baseTree, comparison.baseTree);
            assert.deepEqual(version.changes.map(contentOnly), [
                { status: 'M', oldPath: 'answer.txt', newPath: 'answer.txt', before: 'question\n', after: text },
            ]);
            assert.equal(version.parts?.length, 1);
            assert.notEqual(version.resultTree, comparison.baseTree);
        }
        assert.notEqual(comparison.first.resultTree, comparison.second.resultTree);
        assert.match(comparison.first.metadata?.subject ?? '', /Answer v1$/);
        assert.match(comparison.second.metadata?.subject ?? '', /Answer v2$/);
    });

    test('returns no changes for identical versions', async () => {
        const { repo, base, v1 } = versions();
        const comparison = await compareApplied(gitTool, repo, base, v1, Buffer.from(v1));
        assert.deepEqual(comparison.changes, []);
        assert.deepEqual(comparison.skipped, []);
        assert.equal(comparison.first.resultTree, comparison.second.resultTree);
    });

    test('decodes transfer-encoded versions through the shared application machinery', async () => {
        const repo = makeRepo({ 'eq.txt': 'plain\n' });
        const qp = quotedPrintable('Use equals', [
            'diff --git a/eq.txt b/eq.txt',
            '--- a/eq.txt',
            '+++ b/eq.txt',
            '@@ -1 +1 @@',
            '-plain',
            '+a=b',
        ]);
        const comparison = await compareApplied(gitTool, repo, 'HEAD', qp, Buffer.from(qp));
        assert.deepEqual(comparison.changes, []);
        assert.equal(comparison.first.changes[0]?.after?.toString(), 'a=b\n');
        assert.equal(comparison.first.resultTree, comparison.second.resultTree);
    });

    test('treats a two-message series and its squashed equivalent as identical', async () => {
        const repo = makeRepo({ 'a.txt': 'start\n' });
        const base = git(repo, 'rev-parse', 'HEAD').trim();
        writeFiles(repo, { 'a.txt': 'middle\n' });
        commitAll(repo, 'Step 1');
        writeFiles(repo, { 'a.txt': 'end\n' });
        commitAll(repo, 'Step 2');
        const series = Buffer.from(git(repo, 'format-patch', '--stdout', `${base}..HEAD`));
        const squashed = Buffer.from(git(repo, 'diff', base, 'HEAD'));
        git(repo, 'reset', '-q', '--hard', base);

        const comparison = await compareApplied(gitTool, repo, base, series, squashed);

        assert.deepEqual(comparison.changes, []);
        assert.equal(comparison.first.parts?.length, 2);
        assert.equal(comparison.second.parts?.length, 1);
        assert.equal(comparison.first.resultTree, comparison.second.resultTree);
    });

    test('says which version failed to apply', async () => {
        const { repo, base, v1, v2 } = versions();
        const broken = Buffer.from(v1.toString().replace('-question', '-mystery'));
        await assert.rejects(compareApplied(gitTool, repo, base, broken, v2), (error: unknown) =>
            error instanceof GitError
            && /^First patch: Patch 1\/1/.test(error.message)
            && /patch does not apply/.test(error.message));
        await assert.rejects(compareApplied(gitTool, repo, base, v1, broken), (error: unknown) =>
            error instanceof GitError
            && /^Second patch: Patch 1\/1/.test(error.message)
            && /patch does not apply/.test(error.message));
    });

    test('rejects empty inputs, oversize inputs, and option-like bases before invoking Git', async () => {
        const { repo, base, v1, v2 } = versions();
        class UnreachableGit extends Git {
            override run(): Promise<Buffer> {
                throw new Error('Git must not run.');
            }
        }
        const unreachable = new UnreachableGit();
        await assert.rejects(
            compareApplied(unreachable, repo, base, Buffer.from('notes only\n'), v2),
            /first patch contains no file differences/,
        );
        await assert.rejects(
            compareApplied(unreachable, repo, base, v1, Buffer.alloc(0)),
            /second patch contains no file differences/,
        );
        const limit = Math.min(v1.byteLength, v2.byteLength) - 1;
        await assert.rejects(
            compareApplied(unreachable, repo, base, v1, v2, { maxPatchBytes: limit }),
            OperationLimitError,
        );
        await assert.rejects(compareApplied(unreachable, repo, '--output=x', v1, v2), /is not a revision/);
    });

    test('shares one content budget across both versions and the comparison', async () => {
        const { repo, base, v1, v2 } = versions();
        // Unique blobs: question\n (9 bytes), 42\n (3), and 43\n (3) - 15 bytes in all.
        const comparison = await compareApplied(gitTool, repo, base, v1, v2, { maxContentBytes: 15 });
        assert.equal(comparison.changes.length, 1);
        await assert.rejects(
            compareApplied(gitTool, repo, base, v1, v2, { maxContentBytes: 14 }),
            OperationLimitError,
        );
    });

    test('never writes to the source repository and removes its scratch folder', async () => {
        // A separate target: the result trees from v1 and v2 must not already exist in the repository compared in.
        const { v1, v2 } = versions();
        const target = makeRepo({ 'answer.txt': 'question\n' });
        const snapshot = () => ({
            status: git(target, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'),
            objects: git(target, 'count-objects', '-v'),
            refs: git(target, 'show-ref'),
            files: snapshotFiles(target),
        });
        const before = snapshot();
        const trees: string[] = [];
        class InspectingGit extends Git {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                const output = await super.run(args, options);
                if (args.includes('write-tree')) {
                    trees.push(output.toString('utf8').trim());
                }
                return output;
            }
        }
        const scratchRoot = tempDir('view-patch-interdiff-');

        const comparison = await withTempRoot(scratchRoot, () =>
            compareApplied(new InspectingGit(), target, 'HEAD', v1, v2));

        assert.equal(comparison.changes.length, 1);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(readdirSync(scratchRoot), []);
        assert.equal(trees.length, 2);
        for (const tree of [...trees, comparison.first.resultTree, comparison.second.resultTree]) {
            assert.equal(await gitTool.succeeds(['cat-file', '-e', tree], { cwd: target }), false);
        }
    });

    test('propagates cancellation between the versions and cleans the scratch folder', async () => {
        const { repo, base, v1, v2 } = versions();
        const controller = new AbortController();
        let applies = 0;
        class CancellingGit extends Git {
            override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
                const output = await super.run(args, options);
                if (args.includes('apply') && args.includes('--cached')) {
                    applies += 1;
                    if (applies === 2) {
                        controller.abort();
                    }
                }
                return output;
            }
        }
        const scratchRoot = tempDir('view-patch-interdiff-cancel-');
        await withTempRoot(scratchRoot, () => assert.rejects(
            compareApplied(new CancellingGit(), repo, base, v1, v2, { signal: controller.signal }),
            OperationCancelledError,
        ));
        assert.equal(applies, 2);
        assert.deepEqual(readdirSync(scratchRoot), []);
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

// A format-patch style mailbox message whose body is quoted-printable encoded ('=' becomes '=3D').
function quotedPrintable(subject: string, diffLines: readonly string[]): Buffer {
    return Buffer.from([
        'From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001',
        'From: Encoded Author <encoded@example.com>',
        'Date: Mon, 1 Jan 2024 00:00:00 +0000',
        `Subject: [PATCH] ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        diffLines.join('\n').replace(/=/g, '=3D'),
        '',
    ].join('\n'));
}
