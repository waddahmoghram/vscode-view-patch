import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { Git, GitError, GitOptions } from '../../git';
import { OperationLimitError } from '../../operations';
import { AppliedPatchPart, applyPatch, FileChange, patchCommit } from '../../patch';
import { parentOf } from '../../repositories';
import { commitAll, Files, formatPatch, git, makeRepo, removeTempDirs, writeFiles } from '../helpers';

after(removeTempDirs);

function series(initial: Files, steps: readonly Files[]): {
    repo: string;
    base: string;
    commits: readonly string[];
    patch: Buffer;
} {
    const repo = makeRepo(initial);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const commits = steps.map((files, index) => {
        writeFiles(repo, files);
        return commitAll(repo, `Step ${index + 1}`);
    });
    const patch = Buffer.from(git(repo, 'format-patch', '--stdout', '--binary', '-M', `${base}..HEAD`));
    return { repo, base, commits, patch };
}

function file(part: AppliedPatchPart, name: string): FileChange {
    const change = part.changes.find(entry => entry.newPath === name);
    assert.ok(change, `Expected a change for ${name}.`);
    return change;
}

function objects(repo: string): Record<string, string> {
    const result: Record<string, string> = {};
    const root = path.join(repo, '.git', 'objects');
    const visit = (relative: string): void => {
        for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                visit(name);
            } else {
                result[name] = readFileSync(path.join(root, name)).toString('base64');
            }
        }
    };
    visit('');
    return result;
}

class InspectingGit extends Git {
    readonly scratchFolders = new Set<string>();
    readonly trees: string[] = [];
    readonly blobRequests: string[] = [];
    applyCount = 0;

    override async run(args: readonly string[], options: GitOptions): Promise<Buffer> {
        const index = options.env?.GIT_INDEX_FILE;
        if (index) {
            this.scratchFolders.add(path.dirname(index));
        }
        if (args.includes('apply') && args.includes('--cached')) {
            this.applyCount++;
        }
        if (args.includes('--batch')) {
            this.blobRequests.push(...Buffer.from(options.input ?? '').toString('utf8').trim().split('\n'));
        }
        const output = await super.run(args, options);
        if (args.includes('write-tree')) {
            this.trees.push(output.toString('utf8').trim());
        }
        return output;
    }

    assertCleaned(): void {
        assert.equal(this.scratchFolders.size, 1);
        for (const folder of this.scratchFolders) {
            assert.equal(existsSync(folder), false);
        }
    }
}

describe('sequential patch series', () => {
    test('applies two dependent messages and keeps cumulative and per-message versions', async () => {
        const fixture = series({ 'readme.md': 'base\n' }, [
            { 'created.txt': 'one\n' },
            { 'created.txt': 'two\n' },
        ]);
        const tool = new InspectingGit();
        const applied = await applyPatch(tool, fixture.repo, fixture.base, fixture.patch);
        assert.equal(applied.parts?.length, 2);
        const [first, second] = applied.parts ?? [];
        assert.ok(first);
        assert.ok(second);
        assert.equal(file(first, 'created.txt').status, 'A');
        assert.equal(file(first, 'created.txt').before, undefined);
        assert.equal(file(first, 'created.txt').after?.toString(), 'one\n');
        assert.equal(file(second, 'created.txt').before?.toString(), 'one\n');
        assert.equal(file(second, 'created.txt').after?.toString(), 'two\n');
        assert.equal(file(first, 'created.txt').after, file(second, 'created.txt').before);
        assert.equal(file(first, 'created.txt').newId, file(second, 'created.txt').oldId);
        assert.equal(applied.changes[0]?.status, 'A');
        assert.equal(applied.changes[0]?.before, undefined);
        assert.equal(applied.changes[0]?.after, file(second, 'created.txt').after);
        assert.equal(applied.baseTree, git(fixture.repo, 'rev-parse', `${fixture.base}^{tree}`).trim());
        for (const [index, part] of (applied.parts ?? []).entries()) {
            assert.equal(part.metadata.commit, fixture.commits[index]);
            assert.match(part.metadata.subject ?? '', new RegExp(`Step ${index + 1}$`));
            assert.match(part.metadata.author ?? '', /tests@example\.com/);
            assert.ok(part.metadata.date);
            assert.equal(part.metadata.index, index + 1);
            assert.equal(part.metadata.total, 2);
        }
        assert.equal(tool.applyCount, 2);
        assert.equal(tool.blobRequests.length, 2);
        tool.assertCleaned();
    });

    test('keeps three dependent snapshots even when an intermediate file disappears cumulatively', async () => {
        const fixture = series({ 'state.txt': 'zero\n' }, [
            { 'state.txt': 'one\n', 'transient.txt': 'first\n' },
            { 'state.txt': 'two\n', 'transient.txt': 'second\n' },
            { 'state.txt': 'three\n', 'transient.txt': null },
        ]);
        const applied = await applyPatch(new Git(), fixture.repo, fixture.base, fixture.patch);
        assert.equal(applied.parts?.length, 3);
        assert.deepEqual(applied.parts?.map(part => [
            file(part, 'state.txt').before?.toString(),
            file(part, 'state.txt').after?.toString(),
        ]), [['zero\n', 'one\n'], ['one\n', 'two\n'], ['two\n', 'three\n']]);
        assert.deepEqual(applied.parts?.map(part => file(part, 'transient.txt').status), ['A', 'M', 'D']);
        assert.equal(applied.parts?.[2].changes.find(entry => entry.newPath === 'transient.txt')?.after, undefined);
        assert.deepEqual(applied.changes.map(change => [
            change.newPath, change.before?.toString(), change.after?.toString(),
        ]), [['state.txt', 'zero\n', 'three\n']]);
    });

    test('skips a cover letter without confusing its zero hash with a commit', async () => {
        const fixture = series({ 'a.txt': 'one\n' }, [{ 'a.txt': 'two\n' }, { 'a.txt': 'three\n' }]);
        const mailbox = Buffer.from(git(fixture.repo, 'format-patch', '--stdout', '--cover-letter',
            '--binary', `${fixture.base}..HEAD`));
        assert.equal(patchCommit(mailbox.toString('utf8')), undefined);
        const tool = new InspectingGit();
        const applied = await applyPatch(tool, fixture.repo, fixture.base, mailbox);
        assert.equal(tool.applyCount, 2);
        assert.equal(applied.parts?.length, 2);
        assert.equal(applied.metadata?.commit, undefined);
        assert.equal(applied.metadata?.index, 0);
        assert.equal(applied.metadata?.total, 2);
        assert.equal(applied.parts?.[0].metadata.commit, fixture.commits[0]);
        assert.equal(applied.parts?.[1].metadata.commit, fixture.commits[1]);
        tool.assertCleaned();
    });

    test('applies a root commit and its dependent successor on an unstored empty tree', async () => {
        const producer = makeRepo({ 'created.txt': 'one\n' });
        const root = git(producer, 'rev-parse', 'HEAD').trim();
        writeFiles(producer, { 'created.txt': 'two\n' });
        commitAll(producer, 'Refine new file');
        const patch = Buffer.from(git(producer, 'format-patch', '--root', '--stdout', '--binary', 'HEAD'));
        const target = makeRepo({ 'unrelated.txt': 'target content\n' });
        const base = await parentOf(new Git(), producer, root);
        const tool = new InspectingGit();
        const applied = await applyPatch(tool, target, base, patch);
        assert.equal(applied.parts?.length, 2);
        assert.equal(applied.parts?.[0].changes[0]?.before, undefined);
        assert.equal(applied.parts?.[1].changes[0]?.before?.toString(), 'one\n');
        assert.equal(applied.changes[0]?.after?.toString(), 'two\n');
        assert.equal(applied.changes[0]?.oldMode, '000000');
        tool.assertCleaned();
    });

    test('identifies an out-of-order first message and stops without leaking scratch files', async () => {
        const fixture = series({ 'seed.txt': 'base\n' }, [
            { 'created.txt': 'one\n' },
            { 'created.txt': 'two\n' },
        ]);
        const reversed = Buffer.from([...fixture.commits].reverse()
            .map(commit => formatPatch(fixture.repo, commit)).join(''));
        const tool = new InspectingGit();
        await assert.rejects(applyPatch(tool, fixture.repo, fixture.base, reversed), (error: unknown) =>
            error instanceof GitError && /Patch 1\/2 \(.*Step 2\)/.test(error.message));
        assert.equal(tool.applyCount, 1);
        tool.assertCleaned();
    });

    test('identifies a failing later message and never attempts its successor', async () => {
        const fixture = series({ 'a.txt': 'one\n' }, [
            { 'a.txt': 'two\n' },
            { 'a.txt': 'three\n' },
            { 'a.txt': 'four\n' },
        ]);
        const messages = fixture.commits.map(commit => formatPatch(fixture.repo, commit));
        messages[1] = messages[1].replace('-two\n', '-absent\n');
        const tool = new InspectingGit();
        await assert.rejects(
            applyPatch(tool, fixture.repo, fixture.base, Buffer.from(messages.join(''))),
            (error: unknown) => error instanceof GitError &&
                /Patch 2\/3 \(.*Step 2\).*patch does not apply/s.test(error.message),
        );
        assert.equal(tool.applyCount, 2);
        tool.assertCleaned();
    });

    test('uses an exact shared content budget across all unique intermediate blobs', async () => {
        const fixture = series({ 'a.txt': 'one\n' }, [{ 'a.txt': 'two\n' }, { 'a.txt': 'six\n' }]);
        const tool = new InspectingGit();
        const applied = await applyPatch(tool, fixture.repo, fixture.base, fixture.patch, { maxContentBytes: 12 });
        assert.equal(applied.changes[0]?.before?.length, 4);
        assert.equal(applied.changes[0]?.after?.length, 4);
        assert.equal(tool.blobRequests.length, 3);
        assert.equal(new Set(tool.blobRequests).size, 3);
        assert.equal(applied.changes[0].before, applied.parts?.[0].changes[0].before);
        assert.equal(applied.changes[0].after, applied.parts?.[1].changes[0].after);
        tool.assertCleaned();
        const limited = new InspectingGit();
        await assert.rejects(
            applyPatch(limited, fixture.repo, fixture.base, fixture.patch, { maxContentBytes: 11 }),
            OperationLimitError,
        );
        limited.assertCleaned();
    });

    test('stores intermediate trees and previously absent blobs only in one private object database', async () => {
        const fixture = series({ 'a.txt': 'zero\n' }, [
            { 'a.txt': 'one\n' },
            { 'a.txt': 'two\n' },
            { 'a.txt': 'three\n' },
        ]);
        const target = makeRepo({ 'a.txt': 'zero\n' });
        const snapshot = () => ({
            index: readFileSync(path.join(target, '.git', 'index')).toString('base64'),
            objects: objects(target),
            refs: git(target, 'show-ref'),
            status: git(target, '--no-optional-locks', 'status', '--porcelain=v1'),
        });
        const before = snapshot();
        const tool = new InspectingGit();
        const applied = await applyPatch(tool, target, 'HEAD', fixture.patch);
        assert.equal(tool.trees.length, 3);
        assert.deepEqual(snapshot(), before);
        for (const id of [...tool.trees, ...(applied.parts ?? []).flatMap(part =>
            part.changes.map(change => change.newId ?? ''))]) {
            assert.equal(await new Git().succeeds(['cat-file', '-e', id], { cwd: target }), false);
        }
        tool.assertCleaned();
    });
});
