import * as assert from 'assert';
import { writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ShownPatch, ViewPatchApi } from '../../extension';
import { canonical, commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

// Controller features added for 0.3: sample/diagnostics commands, external-change watching,
// persisted checkmarks and remembered repositories, Markdown export, and bulk checkmark commands.
suite('Review workflow commands', () => {
    let repo: string;
    let commit: string;
    let scratch: string;
    let api: ViewPatchApi;
    let sequence = 0;

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension<ViewPatchApi>('waddahmoghram.view-patch');
        assert.ok(extension);
        api = await extension.activate();
        repo = makeRepo({ 'src/value.txt': 'one\n', 'docs/note.md': 'old note\n' });
        writeFiles(repo, { 'src/value.txt': 'two\n', 'docs/note.md': 'new note\n' });
        commit = commitAll(repo, 'Change two files');
        scratch = tempDir();
        await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.reviews.documents.count === 0, 'closed reviews did not release their content');
    });

    suiteTeardown(async () => {
        await settings().update('repositories', undefined, vscode.ConfigurationTarget.Global);
        await removeTempDirs();
    });

    function patchFile(text = formatPatch(repo, commit)): vscode.Uri {
        const file = path.join(scratch, `workflow-${++sequence}.patch`);
        writeFileSync(file, text);
        return vscode.Uri.file(file);
    }

    async function open(uri: vscode.Uri): Promise<ShownPatch> {
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', uri);
        assert.strictEqual(shown.length, 1);
        return shown[0];
    }

    test('opens the built-in sample as an explicitly partial review', async () => {
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openSample');
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'partial');
        assert.strictEqual(shown[0].repo, undefined);
        assert.strictEqual(shown[0].resources.length, 2);
    });

    test('copies diagnostics that identify the install without running a review', async () => {
        const text = await vscode.commands.executeCommand<string>('viewPatch.copyDiagnostics');
        assert.match(text, /^View Patch \d+\.\d+\.\d+/);
        assert.match(text, /Editor: /);
        assert.ok(text.includes(`Platform: ${process.platform} ${process.arch}; Node ${process.versions.node}\n`),
            'the desktop extension host has Node, so the platform line must name it');
        assert.match(text, /Git version: git version \d/);
        assert.match(text, /Open reviews: \d+/);
    });

    test('shows the running environment without copying diagnostics or opening a review', async () => {
        await vscode.env.clipboard.writeText('clipboard before showing the environment');
        const text = await vscode.commands.executeCommand<string>('viewPatch.showEnvironment');
        assert.match(text, /^View Patch \d+\.\d+\.\d+ is running on this computer \((Windows|macOS|Linux)\)\.$/);
        assert.strictEqual(await vscode.env.clipboard.readText(), 'clipboard before showing the environment');
        assert.strictEqual(api.reviews.list().length, 0);
        assert.match(api.reviews.view.description ?? '', /^v\d+\.\d+\.\d+ · local (Windows|macOS|Linux)$/);
        assert.ok(!api.reviews.view.message, "a view message would hide the empty view's welcome buttons");
    });

    test('switches the selected review between modes without choosing the active patch or losing its target', async () => {
        const uri = patchFile();
        const first = await open(uri);
        assert.strictEqual(rootOf(first.id)?.contextValue, 'viewPatch.review.complete');
        const valueIndex = first.resources.findIndex(([label]) => label.endsWith('/src/value.txt'));
        await vscode.commands.executeCommand('viewPatch.toggleReviewed', {
            reviewId: first.id, sectionKey: 'combined', fileIndex: valueIndex,
        });
        const decoy = await open(patchFile());
        await settings().update('repositories', [], vscode.ConfigurationTarget.Global);
        try {
            const partial = await vscode.commands.executeCommand<ShownPatch>(
                'viewPatch.showHunks', { reviewId: first.id });
            assert.strictEqual(partial.id, first.id);
            assert.strictEqual(partial.mode, 'partial');
            assert.strictEqual(partial.repo, undefined, 'a hunk-only review must not claim complete files');
            assert.match(partial.title, /partial context/);
            assert.strictEqual(partial.sections[0].reviewed, 1, 'switching an unchanged patch must keep its marks');
            assert.strictEqual(rootOf(first.id)?.contextValue, 'viewPatch.review.partial');
            assert.strictEqual(api.reviews.list().find(review => review.id === decoy.id)?.mode, 'complete');
            await vscode.commands.executeCommand('viewPatch.markAllReviewed', { reviewId: first.id });
            const complete = await vscode.commands.executeCommand<ShownPatch>(
                'viewPatch.showCompleteFiles', { reviewId: first.id });
            assert.strictEqual(complete.id, first.id);
            assert.strictEqual(complete.mode, 'complete');
            assert.strictEqual(complete.repo, first.repo,
                'the chosen repository must survive even without repository candidates');
            assert.strictEqual(complete.base, first.base);
            assert.strictEqual(complete.sections[0].reviewed, 2, 'marks made on the hunks must carry back');
            assert.strictEqual(rootOf(first.id)?.contextValue, 'viewPatch.review.complete');
            assert.doesNotMatch(complete.title, /partial context/);
            const again = await vscode.commands.executeCommand<ShownPatch>(
                'viewPatch.showCompleteFiles', { reviewId: first.id });
            assert.strictEqual(again.id, first.id);
            assert.strictEqual(api.reviews.list().length, 2, 'switching created another review');
            assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs)
                .filter(tab => tab.label.startsWith(first.title)).length, 1, 'switching left duplicate review tabs');
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('clears checkmarks when the patch changed before a mode switch', async () => {
        const uri = patchFile();
        const first = await open(uri);
        await vscode.commands.executeCommand('viewPatch.markAllReviewed', { reviewId: first.id });
        writeFileSync(uri.fsPath, formatPatch(repo, commit).replace('+two', '+three'));
        const partial = await vscode.commands.executeCommand<ShownPatch>(
            'viewPatch.showHunks', { reviewId: first.id });
        assert.strictEqual(partial.id, first.id);
        assert.strictEqual(partial.mode, 'partial');
        assert.strictEqual(partial.sections[0].reviewed, 0, 'a mark must not outlive a change to the patch');
        assert.match((await readSide(partial, '/src/value.txt')).after ?? '', /three/);
    });

    test('a failed complete-file switch keeps the partial review available', async () => {
        const uri = patchFile(formatPatch(repo, commit).replace('+two', '+three'));
        const [partial] = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', uri);
        await settings().update('repositories', [], vscode.ConfigurationTarget.Global);
        try {
            const complete = await vscode.commands.executeCommand<ShownPatch | undefined>(
                'viewPatch.showCompleteFiles', { reviewId: partial.id });
            assert.strictEqual(complete, undefined);
            assert.strictEqual(api.reviews.list()[0].id, partial.id);
            assert.strictEqual(api.reviews.list()[0].mode, 'partial');
            assert.match((await readSide(partial, '/src/value.txt')).after ?? '', /three/);
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('previews a redacted problem report and, when cancelled, copies and opens nothing', async () => {
        const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): unknown }>('vscode.git');
        assert.ok(gitExtension);
        const exports = (gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()) as
            { getAPI: unknown };
        const getAPI = exports.getAPI;
        // A Git executable under the home folder, as a custom git.path would give, so it reaches the report.
        const executable = path.join(os.homedir(), '.view-patch-test', 'bin', 'git');
        exports.getAPI = () => ({ git: { path: executable }, repositories: [] });
        try {
            await vscode.env.clipboard.writeText('clipboard before the report');
            const { prompts, opened } = await withReportPrompt(() => undefined, async () => {
                assert.strictEqual(await vscode.commands.executeCommand('viewPatch.reportProblem'), false);
            });
            assert.strictEqual(prompts.length, 1);
            const preview = prompts[0].preview ?? '';
            assert.match(preview, /^View Patch problem report\n/);
            assert.match(preview, /^Git executable: ~[\\/]\.view-patch-test[\\/]bin[\\/]git$/m);
            assert.ok(!preview.includes(os.homedir()), `the preview must not contain the home folder:\n${preview}`);
            assert.match(preview, /^Not included: patch content, clipboard content, repository paths/m);
            assert.strictEqual(await vscode.env.clipboard.readText(), 'clipboard before the report');
            assert.deepStrictEqual(opened, []);
        } finally {
            exports.getAPI = getAPI;
        }
    });

    test('copies the previewed report and opens the issue form with no report content in its address', async () => {
        const { prompts, opened } = await withReportPrompt(
            items => items.find(item => item === 'Copy Report and Open Issue Form'),
            async () => {
                assert.strictEqual(await vscode.commands.executeCommand('viewPatch.reportProblem'), true);
            },
        );
        assert.strictEqual(prompts.length, 1);
        assert.match(prompts[0].preview ?? '', /^View Patch problem report\n/);
        assert.strictEqual(await vscode.env.clipboard.readText(), prompts[0].preview);
        assert.deepStrictEqual(opened.map(uri => uri.toString(true)),
            ['https://github.com/waddahmoghram/vscode-view-patch/issues/new?template=bug_report.yml']);
    });

    test('opens a single patch dropped on Patch Reviews, not the patch in the active editor', async () => {
        const decoy = patchFile();
        await vscode.window.showTextDocument(decoy);
        const dropped = patchFile();
        const data = new vscode.DataTransfer();
        data.set('text/uri-list', new vscode.DataTransferItem(`${dropped.toString()}\r\n`));
        const shown = await api.reviews.openDropped(data);
        assert.strictEqual(shown.length, 1);
        assert.ok(shown[0].title.startsWith(`${path.basename(dropped.fsPath)} `), shown[0].title);
    });

    test('marks every file reviewed, exports the summary, then clears the checkmarks', async () => {
        const shown = await open(patchFile());
        await vscode.commands.executeCommand('viewPatch.markAllReviewed', { reviewId: shown.id });
        let current = api.reviews.list().find(review => review.id === shown.id);
        assert.strictEqual(current?.sections[0].reviewed, 2);
        const summary = await vscode.commands.executeCommand<string>(
            'viewPatch.exportSummary', { reviewId: shown.id });
        assert.match(summary, /^# /);
        assert.match(summary, /- Mode: complete files/);
        assert.match(summary, new RegExp(`- Base: .*\\^`));
        assert.match(summary, /- \[x\] `docs\/note\.md` modified/);
        assert.match(summary, /- \[x\] `src\/value\.txt` modified/);
        await vscode.commands.executeCommand('viewPatch.clearReviewed', { reviewId: shown.id });
        current = api.reviews.list().find(review => review.id === shown.id);
        assert.strictEqual(current?.sections[0].reviewed, 0);
        const cleared = await vscode.commands.executeCommand<string>(
            'viewPatch.exportSummary', { reviewId: shown.id });
        assert.match(cleared, /- \[ \] `src\/value\.txt` modified/);
    });

    test('restores reviewed checkmarks when the same unchanged patch is reopened', async () => {
        const uri = patchFile();
        const first = await open(uri);
        const fileIndex = first.resources.findIndex(([label]) => label.endsWith('/src/value.txt'));
        assert.ok(fileIndex >= 0);
        await vscode.commands.executeCommand('viewPatch.toggleReviewed', {
            reviewId: first.id, sectionKey: 'combined', fileIndex,
        });
        await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: first.id });
        await waitFor(() => api.reviews.list().length === 0, 'the review did not close');
        const second = await open(uri);
        assert.notStrictEqual(second.id, first.id);
        assert.strictEqual(second.sections[0].reviewed, 1,
            'the persisted checkmark did not survive closing and reopening the review');
    });

    test('reuses the remembered repository when no candidate repositories remain', async () => {
        const uri = patchFile();
        const first = await open(uri);
        assert.ok(first.repo);
        assert.strictEqual(canonical(first.repo), canonical(repo));
        await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: first.id });
        await waitFor(() => api.reviews.list().length === 0, 'the review did not close');
        await settings().update('repositories', undefined, vscode.ConfigurationTarget.Global);
        try {
            const second = await open(uri);
            assert.strictEqual(second.mode, 'complete');
            assert.ok(second.repo);
            assert.strictEqual(canonical(second.repo), canonical(repo),
                'the remembered repository was not used after the setting was cleared');
            assert.strictEqual(second.base, `${commit}^`);
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('flags an externally regenerated source patch without replacing the snapshot', async () => {
        const uri = patchFile();
        const shown = await open(uri);
        assert.notStrictEqual(shown.sourceChanged, true);
        const edited = formatPatch(repo, commit).replace('+two', '+three');
        assert.notStrictEqual(edited, formatPatch(repo, commit));
        writeFileSync(uri.fsPath, edited);
        await waitFor(
            () => api.reviews.list().find(review => review.id === shown.id)?.sourceChanged === true,
            'the external change was not noticed by the watcher',
            15_000,
        );
        const sides = await readSide(shown, '/src/value.txt');
        assert.match(sides.after ?? '', /two/, 'the open snapshot must keep showing the earlier content');
    });

    test('compares two patch versions as a result difference on the same base', async () => {
        const uri = patchFile();
        const first = await open(uri);
        const otherFile = path.join(scratch, `workflow-other-${++sequence}.patch`);
        writeFileSync(otherFile, formatPatch(repo, commit).replace('+two', '+three'));
        const shown = await vscode.commands.executeCommand<ShownPatch | undefined>(
            'viewPatch.compareWith', { reviewId: first.id }, vscode.Uri.file(otherFile));
        assert.ok(shown, 'the comparison did not open a review');
        assert.strictEqual(shown.mode, 'complete');
        assert.match(shown.title, / vs /);
        assert.strictEqual(shown.base, first.base);
        assert.strictEqual(shown.resources.length, 1, 'only the file the versions disagree on should differ');
        const sides = await readSide(shown, '/src/value.txt');
        assert.strictEqual(sides.before, 'two\n');
        assert.strictEqual(sides.after, 'three\n');
        assert.strictEqual(rootOf(shown.id)?.contextValue, 'viewPatch.review.pinned');
        await assert.rejects(api.reviews.switchMode({ reviewId: shown.id }, 'partial'),
            /Commit and version-comparison reviews are already complete-file snapshots/);
        assert.strictEqual(api.reviews.list().find(review => review.id === shown.id)?.mode, 'complete');
    });

    test('reports identical patch versions instead of opening an empty comparison', async () => {
        const uri = patchFile();
        const first = await open(uri);
        const copy = path.join(scratch, `workflow-copy-${++sequence}.patch`);
        writeFileSync(copy, formatPatch(repo, commit));
        const before = api.reviews.list().length;
        const shown = await vscode.commands.executeCommand<ShownPatch | undefined>(
            'viewPatch.compareWith', { reviewId: first.id }, vscode.Uri.file(copy));
        assert.strictEqual(shown, undefined);
        assert.strictEqual(api.reviews.list().length, before, 'an empty comparison must not create a review');
    });

    test('declines an already-applied plain diff without opening a wrong review', async () => {
        const text = git(repo, 'diff', `${commit}^`, commit);
        assert.match(text, /^diff --git/m);
        const file = path.join(scratch, `workflow-applied-${++sequence}.patch`);
        writeFileSync(file, text);
        const shown = await vscode.commands.executeCommand<ShownPatch[]>(
            'viewPatch.open', vscode.Uri.file(file));
        assert.deepStrictEqual(shown, [], 'an already-applied patch must not open a complete review');
        assert.ok(!api.reviews.list().some(review => review.title.includes('workflow-applied')),
            'no review should exist for the already-applied patch');
    });

    function makeMerge(): { mergeRepo: string; mergeCommit: string; text: string } {
        const mergeRepo = makeRepo({ 'shared.txt': 'line one\nline two\nline three\n' });
        git(mergeRepo, 'checkout', '-q', '-b', 'left');
        writeFiles(mergeRepo, { 'shared.txt': 'LEFT one\nline two\nline three\n' });
        commitAll(mergeRepo, 'Left change');
        git(mergeRepo, 'checkout', '-q', 'main');
        git(mergeRepo, 'checkout', '-q', '-b', 'right');
        writeFiles(mergeRepo, { 'shared.txt': 'line one\nline two\nRIGHT three\n' });
        commitAll(mergeRepo, 'Right change');
        git(mergeRepo, 'checkout', '-q', 'left');
        git(mergeRepo, 'merge', '-q', '--no-ff', '-m', 'Merge right into left', 'right');
        const mergeCommit = git(mergeRepo, 'rev-parse', 'HEAD').trim();
        const text = git(mergeRepo, 'show', '--cc', mergeCommit);
        assert.match(text, /^diff --cc shared\.txt$/m, 'the fixture did not produce a combined diff');
        return { mergeRepo, mergeCommit, text };
    }

    test('shows a merge commit as real per-parent changes when its repository is known', async () => {
        const { mergeRepo, mergeCommit, text } = makeMerge();
        const file = path.join(scratch, `workflow-merge-${++sequence}.patch`);
        writeFileSync(file, text);
        await settings().update('repositories', [repo, mergeRepo], vscode.ConfigurationTarget.Global);
        try {
            const shown = await vscode.commands.executeCommand<ShownPatch[]>(
                'viewPatch.open', vscode.Uri.file(file));
            assert.strictEqual(shown.length, 1);
            assert.strictEqual(shown[0].mode, 'complete');
            assert.strictEqual(shown[0].sections.length, 2);
            assert.ok(shown[0].sections.every(section => /Versus parent [12] /.test(section.label)),
                shown[0].sections.map(section => section.label).join('; '));
            const firstParent = git(mergeRepo, 'rev-parse', `${mergeCommit}^1`).trim();
            assert.strictEqual(shown[0].base, firstParent);
            const sides = await readSide(shown[0], '/shared.txt');
            assert.match(sides.before ?? '', /LEFT one/, 'parent 1 content expected on the left');
            assert.match(sides.before ?? '', /line three/);
            assert.match(sides.after ?? '', /LEFT one/);
            assert.match(sides.after ?? '', /RIGHT three/, 'the merged result expected on the right');
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('shows per-parent hunk views for a combined diff whose repository is unknown', async () => {
        const { text } = makeMerge();
        const file = path.join(scratch, `workflow-combined-${++sequence}.patch`);
        writeFileSync(file, text);
        const shown = await vscode.commands.executeCommand<ShownPatch[]>(
            'viewPatch.openHunks', vscode.Uri.file(file));
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'partial');
        assert.strictEqual(shown[0].repo, undefined);
        assert.strictEqual(shown[0].sections.length, 2);
        assert.ok(shown[0].sections.every(section => /Versus parent [12] \(hunks\)/.test(section.label)),
            shown[0].sections.map(section => section.label).join('; '));
        const sides = await readSide(shown[0], '/shared.txt');
        assert.match(sides.after ?? '', /RIGHT three/);
    });

    function quotedPrintableMail(from: string, revision: string): string {
        const original = formatPatch(from, revision);
        const headerEnd = original.indexOf('\n\n');
        assert.ok(headerEnd > 0);
        return original.slice(0, headerEnd)
            + '\nMIME-Version: 1.0'
            + '\nContent-Type: text/plain; charset=utf-8'
            + '\nContent-Transfer-Encoding: quoted-printable'
            + '\n\n'
            + original.slice(headerEnd + 2)
                .replace(/=/g, '=3D')
                // The specification requires encoding trailing whitespace; decoders strip it otherwise.
                .replace(/ (?=\n)/g, '=20');
    }

    test('decodes a quoted-printable mail body for hunk viewing', async () => {
        const qpRepo = makeRepo({ 'eq.txt': 'a=1\n' });
        writeFiles(qpRepo, { 'eq.txt': 'a=2\n' });
        const qpCommit = commitAll(qpRepo, 'Change the equation');
        const file = path.join(scratch, `workflow-qp-${++sequence}.patch`);
        writeFileSync(file, quotedPrintableMail(qpRepo, qpCommit));
        const shown = await vscode.commands.executeCommand<ShownPatch[]>(
            'viewPatch.openHunks', vscode.Uri.file(file));
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'partial');
        const sides = await readSide(shown[0], '/eq.txt');
        assert.match(sides.after ?? '', /a=2/, 'the decoded content must show a=2, not a=3D2');
        assert.doesNotMatch(sides.after ?? '', /=3D/);
    });

    test('applies a quoted-printable mail as a complete review', async () => {
        const qpRepo = makeRepo({ 'eq.txt': 'a=1\n' });
        writeFiles(qpRepo, { 'eq.txt': 'a=2\n' });
        const qpCommit = commitAll(qpRepo, 'Change the equation');
        const file = path.join(scratch, `workflow-qp-full-${++sequence}.patch`);
        writeFileSync(file, quotedPrintableMail(qpRepo, qpCommit));
        await settings().update('repositories', [repo, qpRepo], vscode.ConfigurationTarget.Global);
        try {
            const shown = await vscode.commands.executeCommand<ShownPatch[]>(
                'viewPatch.open', vscode.Uri.file(file));
            assert.strictEqual(shown.length, 1);
            assert.strictEqual(shown[0].mode, 'complete');
            assert.strictEqual(shown[0].base, `${qpCommit}^`);
            const sides = await readSide(shown[0], '/eq.txt');
            assert.strictEqual(sides.before, 'a=1\n');
            assert.strictEqual(sides.after, 'a=2\n');
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('opens a patch straight from the clipboard', async () => {
        await vscode.env.clipboard.writeText(formatPatch(repo, commit));
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openFromClipboard');
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'complete');
        assert.strictEqual(canonical(shown[0].repo ?? ''), canonical(repo));
    });

    test('declines clipboard text that is not a patch', async () => {
        await vscode.env.clipboard.writeText('just some prose, no diff headers');
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openFromClipboard');
        assert.deepStrictEqual(shown, []);
    });

    test('reviews a commit from history without any patch file', async () => {
        const shown = await vscode.commands.executeCommand<ShownPatch | undefined>(
            'viewPatch.reviewCommit', repo, commit);
        assert.ok(shown);
        assert.strictEqual(shown.mode, 'complete');
        const parent = git(repo, 'rev-parse', `${commit}^`).trim();
        assert.strictEqual(shown.base, parent);
        assert.strictEqual(shown.sections.length, 1);
        assert.match(shown.sections[0].label, /Versus parent 1 /);
        const sides = await readSide(shown, '/src/value.txt');
        assert.strictEqual(sides.before, 'one\n');
        assert.strictEqual(sides.after, 'two\n');
        // Checkmarks key to the immutable commit: toggle, close, review again, and expect it back.
        const fileIndex = shown.resources.findIndex(([label]) =>
            vscode.Uri.parse(label).path.endsWith('/src/value.txt'));
        await vscode.commands.executeCommand('viewPatch.toggleReviewed', {
            reviewId: shown.id, sectionKey: 'combined', fileIndex,
        });
        await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: shown.id });
        await waitFor(() => api.reviews.list().length === 0, 'the commit review did not close');
        const again = await vscode.commands.executeCommand<ShownPatch | undefined>(
            'viewPatch.reviewCommit', repo, commit);
        assert.strictEqual(again?.sections[0].reviewed, 1);
    });

    test('reviews a merge commit per parent from history', async () => {
        const { mergeRepo, mergeCommit } = makeMerge();
        const shown = await vscode.commands.executeCommand<ShownPatch | undefined>(
            'viewPatch.reviewCommit', mergeRepo, mergeCommit);
        assert.ok(shown);
        assert.strictEqual(shown.sections.length, 2);
        assert.ok(shown.sections.every(section => /Versus parent [12] /.test(section.label)));
        assert.strictEqual(shown.base, git(mergeRepo, 'rev-parse', `${mergeCommit}^1`).trim());
    });

    test('steps through unreviewed files, auto-marking when configured', async () => {
        const shown = await open(patchFile());
        await settings().update('markReviewedOnOpen', true, vscode.ConfigurationTarget.Global);
        try {
            await vscode.commands.executeCommand('viewPatch.nextUnreviewed', { reviewId: shown.id });
            let current = api.reviews.list().find(review => review.id === shown.id);
            assert.strictEqual(current?.sections[0].reviewed, 1);
            await vscode.commands.executeCommand('viewPatch.nextUnreviewed', { reviewId: shown.id });
            current = api.reviews.list().find(review => review.id === shown.id);
            assert.strictEqual(current?.sections[0].reviewed, 2);
            // Every file reviewed: the command reports instead of opening anything new.
            await vscode.commands.executeCommand('viewPatch.nextUnreviewed', { reviewId: shown.id });
            current = api.reviews.list().find(review => review.id === shown.id);
            assert.strictEqual(current?.sections[0].reviewed, 2);
        } finally {
            await settings().update('markReviewedOnOpen', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('copies one file as a valid, applyable unified diff', async () => {
        const shown = await open(patchFile());
        const fileIndex = shown.resources.findIndex(([label]) =>
            vscode.Uri.parse(label).path.endsWith('/src/value.txt'));
        assert.ok(fileIndex >= 0);
        const text = await vscode.commands.executeCommand<string>('viewPatch.copyFileDiff', {
            reviewId: shown.id, sectionKey: 'combined', fileIndex,
        });
        assert.match(text, /^--- a\/src\/value\.txt$/m);
        assert.match(text, /^\+\+\+ b\/src\/value\.txt$/m);
        assert.match(text, /^-one$/m);
        assert.match(text, /^\+two$/m);
        const copied = path.join(scratch, `copied-${++sequence}.patch`);
        writeFileSync(copied, text);
        // Round-trip: Git itself must accept the copied diff against the base.
        const worktree = path.join(scratch, `apply-check-${sequence}`);
        git(repo, 'worktree', 'add', '--detach', worktree, `${commit}^`);
        try {
            git(worktree, 'apply', '--check', copied);
        } finally {
            git(repo, 'worktree', 'remove', '--force', worktree);
        }
    });

    test('summary export includes per-file line counts for complete reviews', async () => {
        const shown = await open(patchFile());
        const summary = await vscode.commands.executeCommand<string>(
            'viewPatch.exportSummary', { reviewId: shown.id });
        assert.match(summary, /`src\/value\.txt` modified \(\+1\/-1\)/);
        assert.match(summary, /`docs\/note\.md` modified \(\+1\/-1\)/);
    });
});

function settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('viewPatch');
}

function rootOf(reviewId: string): vscode.TreeItem | undefined {
    const extension = vscode.extensions.getExtension<ViewPatchApi>('waddahmoghram.view-patch');
    return extension?.exports.reviews.tree.getChildren().find(node => node.reviewId === reviewId);
}

interface ReportPrompt {
    readonly items: readonly unknown[];
    /** The active editor's text when the prompt appeared. */
    readonly preview?: string;
}

/** Answers the report prompt and records external opens instead of launching a browser. */
async function withReportPrompt(
    answer: (items: readonly unknown[]) => unknown,
    run: () => Promise<void>,
): Promise<{ prompts: ReportPrompt[]; opened: vscode.Uri[] }> {
    const window = vscode.window as { showInformationMessage: unknown };
    const env = vscode.env as { openExternal: unknown };
    const show = window.showInformationMessage;
    const openExternal = env.openExternal;
    const prompts: ReportPrompt[] = [];
    const opened: vscode.Uri[] = [];
    window.showInformationMessage = async (_message: string, ...rest: unknown[]) => {
        const items = rest.filter(item => typeof item === 'string');
        prompts.push({ items, preview: vscode.window.activeTextEditor?.document.getText() });
        return answer(items);
    };
    env.openExternal = async (uri: vscode.Uri) => {
        opened.push(uri);
        return true;
    };
    try {
        await run();
    } finally {
        window.showInformationMessage = show;
        env.openExternal = openExternal;
    }
    return { prompts, opened };
}

async function readSide(shown: ShownPatch, suffix: string): Promise<{ before?: string; after?: string }> {
    const resource = shown.resources.find(([label]) => vscode.Uri.parse(label).path.endsWith(suffix));
    assert.ok(resource, `no resource ends with ${suffix}`);
    const text = async (uri: string | undefined) =>
        uri === undefined ? undefined : (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText();
    return { before: await text(resource[1]), after: await text(resource[2]) };
}

async function waitFor(
    check: () => boolean | Promise<boolean>,
    message: string,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        assert.ok(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 30));
    }
}
