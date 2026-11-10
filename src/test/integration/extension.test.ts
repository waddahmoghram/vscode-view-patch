import * as assert from 'assert';
import { writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ShownPatch, ViewPatchApi } from '../../extension';
import { canonical, commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

interface Side {
    file: string;
    before?: string;
    after?: string;
}

suite('View Patch commands', () => {
    let repo: string;
    let commit: string;
    let scratch: string;
    let api: ViewPatchApi;
    let sequence = 0;

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension<ViewPatchApi>('waddahmoghram.view-patch');
        assert.ok(extension);
        api = await extension.activate();
        repo = makeRepo({ 'src/app.ts': 'export const answer = 41;\n', 'notes.md': '# Notes\n', 'old.txt': 'old\n' });
        writeFiles(repo, { 'src/app.ts': 'export const answer = 42;\n', 'docs/new.md': '# New\n', 'old.txt': null });
        commit = commitAll(repo, 'Change the answer');
        scratch = tempDir();
        await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.reviews.documents.count === 0, 'closed reviews did not release their content');
        await vscode.commands.executeCommand('viewPatch.clearFilter');
    });

    suiteTeardown(async () => {
        await settings().update('repositories', undefined, vscode.ConfigurationTarget.Global);
        removeTempDirs();
    });

    function patchFile(text = formatPatch(repo, commit), name?: string): vscode.Uri {
        const file = path.join(scratch, name ?? `change-${++sequence}.patch`);
        writeFileSync(file, text);
        return vscode.Uri.file(file);
    }

    async function open(uri: vscode.Uri): Promise<ShownPatch> {
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', uri);
        assert.strictEqual(shown.length, 1);
        return shown[0];
    }

    test('opens complete files in one Changes tab and preserves a repository/base summary', async () => {
        const shown = await open(patchFile());
        assert.strictEqual(shown.mode, 'complete');
        assert.ok(shown.repo);
        assert.strictEqual(canonical(shown.repo), canonical(repo));
        assert.strictEqual(shown.base, `${commit}^`);
        assert.match(shown.baseTree ?? '', /^[0-9a-f]{40,64}$/);
        assert.deepStrictEqual(await readSides(shown), [
            { file: 'docs/new.md', before: undefined, after: '# New\n' },
            { file: 'old.txt', before: 'old\n', after: undefined },
            { file: 'src/app.ts', before: 'export const answer = 41;\n', after: 'export const answer = 42;\n' },
        ]);
        assert.strictEqual(reviewTabs(shown).length, 1);
        const root = api.reviews.tree.getChildren()[0];
        const summary = api.reviews.tree.getChildren(root).filter(node => node.kind === 'info').map(nodeLabel);
        assert.ok(summary.some(label => label.includes(repo)));
        assert.ok(summary.some(label => label.includes(`${commit}^`)));
        const details = api.reviews.tree.getChildren(root).find(node => node.kind === 'details');
        assert.ok(details);
        assert.ok(api.reviews.tree.getChildren(details).some(node => nodeLabel(node).includes('Snapshot tree:')));
    });

    test('reuses the review and tab when the same patch is opened again', async () => {
        const uri = patchFile();
        const first = await open(uri);
        const second = await open(uri);
        assert.strictEqual(second.id, first.id);
        assert.strictEqual(api.reviews.list().length, 1);
        assert.strictEqual(reviewTabs(first).length, 1, 'opening twice created duplicate Changes tabs');
    });

    test('coalesces simultaneous opens of the same patch', async () => {
        const uri = patchFile();
        const [first, second] = await Promise.all([open(uri), open(uri)]);
        assert.strictEqual(first.id, second.id);
        assert.strictEqual(api.reviews.list().length, 1);
        assert.strictEqual(reviewTabs(first).length, 1);
    });

    test('refreshes one review, retaining only unchanged reviewed checkmarks', async () => {
        const uri = patchFile();
        const shown = await open(uri);
        const sourceIndex = shown.resources.findIndex(([label]) => label.endsWith('/src/app.ts'));
        const docsIndex = shown.resources.findIndex(([label]) => label.endsWith('/docs/new.md'));
        assert.ok(sourceIndex >= 0 && docsIndex >= 0);
        for (const index of [sourceIndex, docsIndex]) {
            await vscode.commands.executeCommand('viewPatch.toggleReviewed', {
                reviewId: shown.id, sectionKey: 'combined', fileIndex: index,
            });
        }
        assert.strictEqual(api.reviews.list()[0].sections[0].reviewed, 2);
        const edited = formatPatch(repo, commit).replace('+export const answer = 42;', '+export const answer = 43;');
        writeFileSync(uri.fsPath, edited);
        const refreshed = await vscode.commands.executeCommand<ShownPatch>(
            'viewPatch.refresh', { reviewId: shown.id },
        );
        assert.strictEqual(refreshed.id, shown.id);
        assert.strictEqual(refreshed.sections[0].reviewed, 1);
        assert.strictEqual(reviewTabs(shown).length, 1);
        await waitFor(
            async () => (await readSides(refreshed)).some(side => side.after?.includes('answer = 43;') === true),
            'the refreshed document did not update',
        );
    });

    test('filters paths in the persistent review checklist', async () => {
        await open(patchFile());
        const root = api.reviews.tree.getChildren()[0];
        await vscode.commands.executeCommand('viewPatch.filter', 'src/');
        const filtered = api.reviews.tree.getChildren(root).filter(node => node.kind === 'file');
        assert.deepStrictEqual(filtered.map(nodeLabel), ['src/app.ts']);
        await vscode.commands.executeCommand('viewPatch.clearFilter');
        assert.strictEqual(api.reviews.tree.getChildren(root).filter(node => node.kind === 'file').length, 3);
    });

    test('offers refresh on save without silently replacing the reviewed snapshot', async () => {
        const uri = patchFile();
        const shown = await open(uri);
        const source = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(source.positionAt(0), source.positionAt(source.getText().length)),
            source.getText().replace('+export const answer = 42;', '+export const answer = 43;'));
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(await source.save(), true);
        const root = api.reviews.tree.getChildren()[0];
        assert.ok(api.reviews.tree.getChildren(root).some(node => nodeLabel(node).includes('source patch changed')));
        assert.ok((await readSides(shown)).some(side => side.after?.includes('answer = 42;')));
        const refreshed = await vscode.commands.executeCommand<ShownPatch>(
            'viewPatch.refresh', { reviewId: shown.id },
        );
        await waitFor(
            async () => (await readSides(refreshed)).some(side => side.after?.includes('answer = 43;') === true),
            'saved patch did not refresh',
        );
    });

    test('Open With opens the same Changes viewer without a lingering custom-editor tab', async () => {
        await vscode.commands.executeCommand('vscode.openWith', patchFile(), 'viewPatch.editor');
        await waitFor(() => api.reviews.list().length === 1, 'Open With did not create a review');
        const shown = api.reviews.list()[0];
        await waitFor(() => reviewTabs(shown).length === 1, 'Open With did not show a Changes tab');
        await waitFor(() => !allTabs().some(tab => tab.input instanceof vscode.TabInputCustom),
            'the request editor did not close');
        assert.strictEqual((await readSides(shown)).length, 3);
    });

    test('shows explicit partial context without needing the patch repository', async () => {
        const uri = patchFile([
            'diff --git a/missing.txt b/missing.txt', '--- a/missing.txt', '+++ b/missing.txt',
            '@@ -10 +10 @@', '-old context', '+new context', '',
        ].join('\n'));
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', uri);
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'partial');
        assert.strictEqual(shown[0].repo, undefined);
        assert.match(shown[0].title, /partial context/);
        const [side] = await readSides(shown[0]);
        assert.match(side.before ?? '', /partial/i);
        assert.match(side.after ?? '', /new context/);
        const root = api.reviews.tree.getChildren()[0];
        assert.ok(api.reviews.tree.getChildren(root).some(node => nodeLabel(node).includes('not complete files')));
    });

    test('navigates dependent series as combined changes and individual patches', async () => {
        const seriesRepo = makeRepo({ 'value.txt': 'zero\n' });
        writeFiles(seriesRepo, { 'value.txt': 'one\n' });
        commitAll(seriesRepo, 'First change');
        writeFiles(seriesRepo, { 'value.txt': 'two\n', 'added.txt': 'new\n' });
        commitAll(seriesRepo, 'Second change');
        const text = git(seriesRepo, 'format-patch', '-2', '--stdout', '--binary');
        await settings().update('repositories', [repo, seriesRepo], vscode.ConfigurationTarget.Global);
        try {
            const shown = await open(patchFile(text));
            assert.strictEqual(shown.sections.length, 3);
            assert.deepStrictEqual(await readSides(shown), [
                { file: 'added.txt', before: undefined, after: 'new\n' },
                { file: 'value.txt', before: 'zero\n', after: 'two\n' },
            ]);
            const first = await vscode.commands.executeCommand<ShownPatch>('viewPatch.showReview', {
                reviewId: shown.id, sectionKey: 'part1',
            });
            assert.deepStrictEqual(await readSides(first), [
                { file: 'value.txt', before: 'zero\n', after: 'one\n' },
            ]);
            const second = await vscode.commands.executeCommand<ShownPatch>('viewPatch.showReview', {
                reviewId: shown.id, sectionKey: 'part2',
            });
            assert.deepStrictEqual(await readSides(second), [
                { file: 'added.txt', before: undefined, after: 'new\n' },
                { file: 'value.txt', before: 'one\n', after: 'two\n' },
            ]);
            assert.strictEqual(reviewTabs(shown).length, 1, 'series navigation opened extra main tabs');
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('keeps individual patches reviewable when their cumulative changes cancel out', async () => {
        const seriesRepo = makeRepo({ 'value.txt': 'zero\n' });
        writeFiles(seriesRepo, { 'value.txt': 'one\n' });
        commitAll(seriesRepo, 'Temporary change');
        writeFiles(seriesRepo, { 'value.txt': 'zero\n' });
        commitAll(seriesRepo, 'Undo temporary change');
        await settings().update('repositories', [seriesRepo], vscode.ConfigurationTarget.Global);
        try {
            const shown = await open(patchFile(git(seriesRepo, 'format-patch', '-2', '--stdout')));
            assert.strictEqual(shown.sections[0].files, 0);
            assert.strictEqual(shown.sections[1].files, 1);
            assert.strictEqual(shown.sections[2].files, 1);
            assert.strictEqual(reviewTabs(shown).length, 1);
            assert.deepStrictEqual(await readSides(shown), [
                { file: 'value.txt', before: 'zero\n', after: 'one\n' },
            ]);
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('opens separate numbered files as one dependent series and can refresh it', async () => {
        const authorRepo = makeRepo({ 'value.txt': 'zero\n' });
        writeFiles(authorRepo, { 'value.txt': 'one\n' });
        const firstCommit = commitAll(authorRepo, 'First');
        writeFiles(authorRepo, { 'value.txt': 'two\n' });
        const secondCommit = commitAll(authorRepo, 'Second');
        const target = makeRepo({ 'value.txt': 'zero\n' });
        const first = patchFile(formatPatch(authorRepo, firstCommit), '0001-first.patch');
        const second = patchFile(formatPatch(authorRepo, secondCommit), '0002-second.patch');
        await settings().update('repositories', [target], vscode.ConfigurationTarget.Global);
        try {
            const [shown] = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openSeries',
                second, [second, first]);
            assert.strictEqual(shown.sections.length, 3);
            assert.strictEqual(shown.base, 'HEAD');
            assert.strictEqual((await readSides(shown))[0].after, 'two\n');
            const refreshed = await vscode.commands.executeCommand<ShownPatch>('viewPatch.refresh', {
                reviewId: shown.id,
            });
            assert.strictEqual(refreshed.id, shown.id);
            assert.strictEqual((await readSides(refreshed))[0].after, 'two\n');
            const [reopened] = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openSeries',
                first, [first, second]);
            assert.strictEqual(reopened.id, shown.id);
            assert.strictEqual(reviewTabs(shown).length, 1);
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('does not invent a combined complete-file view for a repository-free series', async () => {
        const seriesRepo = makeRepo({ 'value.txt': 'zero\n' });
        writeFiles(seriesRepo, { 'value.txt': 'one\n' });
        commitAll(seriesRepo, 'First');
        writeFiles(seriesRepo, { 'value.txt': 'two\n' });
        commitAll(seriesRepo, 'Second');
        const uri = patchFile(git(seriesRepo, 'format-patch', '-2', '--stdout'));
        const [shown] = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', uri);
        assert.strictEqual(shown.mode, 'partial');
        assert.deepStrictEqual(shown.sections.map(section => section.key), ['part1', 'part2']);
        assert.match((await readSides(shown))[0].after ?? '', /partial/i);
        const second = await vscode.commands.executeCommand<ShownPatch>('viewPatch.showReview', {
            reviewId: shown.id, sectionKey: 'part2',
        });
        assert.match((await readSides(second))[0].after ?? '', /two/);
    });

    test('lists mode-only changes and renames instead of losing them in notifications', async () => {
        const metadataRepo = makeRepo({ 'old.txt': 'unchanged\n', 'run.sh': 'echo example\n' });
        writeFiles(metadataRepo, { 'old.txt': null, 'new.txt': 'unchanged\n' });
        git(metadataRepo, 'add', '-A');
        git(metadataRepo, 'update-index', '--chmod=+x', 'run.sh');
        git(metadataRepo, 'commit', '-q', '-m', 'Rename and change mode');
        await settings().update('repositories', [metadataRepo], vscode.ConfigurationTarget.Global);
        try {
            const shown = await open(patchFile(formatPatch(metadataRepo)));
            assert.strictEqual(shown.sections[0].files, 2);
            const sides = await readSides(shown);
            assert.ok(sides.every(
                side => side.before?.includes('Metadata only') && side.after?.includes('Metadata only'),
            ));
            const script = sides.find(side => side.file === 'run.sh');
            assert.match(script?.before ?? '', /100644/);
            assert.match(script?.after ?? '', /100755/);
            const root = api.reviews.tree.getChildren()[0];
            assert.strictEqual(api.reviews.tree.getChildren(root).filter(node => node.kind === 'file').length, 2);
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('displays equal-size binary changes truthfully in the actual Changes documents', async () => {
        const binaryRepo = makeRepo({ 'data.bin': Buffer.from([0, 1, 2]) });
        writeFiles(binaryRepo, { 'data.bin': Buffer.from([0, 1, 3]) });
        commitAll(binaryRepo, 'Change binary');
        await settings().update('repositories', [binaryRepo], vscode.ConfigurationTarget.Global);
        try {
            const shown = await open(patchFile(formatPatch(binaryRepo)));
            const [side] = await readSides(shown);
            assert.match(side.before ?? '', /3 bytes/);
            assert.match(side.after ?? '', /3 bytes/);
            assert.notStrictEqual(side.before, side.after);
        } finally {
            await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        }
    });

    test('retains more than twenty open reviews without losing earlier content', async () => {
        let first: ShownPatch | undefined;
        const singleFile = git(repo, 'format-patch', '-1', '--stdout', commit, '--', 'src/app.ts');
        for (let index = 0; index < 21; index++) {
            const shown = await open(patchFile(singleFile));
            first ??= shown;
        }
        assert.ok(first);
        assert.strictEqual(api.reviews.documents.count, 21, describeTabs());
        assert.strictEqual(api.reviews.list().length, 21);
        assert.ok((await readSides(first)).some(side => side.after?.includes('answer = 42;')));
        await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: first.id });
        assert.strictEqual(api.reviews.documents.count, 20);
    });

    test('retains a review while an individual file diff remains open', async () => {
        const shown = await open(patchFile());
        await vscode.commands.executeCommand('viewPatch.openFile', {
            reviewId: shown.id, sectionKey: 'combined', fileIndex: 0,
        });
        assert.ok(allTabs().length >= 2, `the file diff replaced its parent review:\n${describeTabs()}`);
        const main = reviewTabs(shown)[0];
        assert.ok(main);
        await vscode.window.tabGroups.close(main, true);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.strictEqual(api.reviews.documents.count, 1, describeTabs());
        assert.ok((await readSides(shown))[0].after?.includes('# New'));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.reviews.documents.count === 0, 'the last closed diff did not release the review');
    });

    test('closing a review does not close an unrelated editor', async () => {
        const file = path.join(scratch, 'unrelated.txt');
        writeFileSync(file, 'Not part of any patch review.\n');
        const uri = vscode.Uri.file(file);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
        const shown = await open(patchFile());
        await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: shown.id });
        assert.ok(allTabs().some(tab => tab.input instanceof vscode.TabInputText
            && tab.input.uri.toString() === uri.toString()));
    });

    test('opens unsaved patch text from the active editor', async () => {
        const reverse = git(repo, 'diff', commit, `${commit}^`, '--', 'src/app.ts');
        const document = await vscode.workspace.openTextDocument({ language: 'diff', content: reverse });
        await vscode.window.showTextDocument(document);
        try {
            const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open');
            assert.strictEqual(shown.length, 1);
            assert.strictEqual(shown[0].base, 'HEAD');
            assert.deepStrictEqual(await readSides(shown[0]), [
                { file: 'src/app.ts', before: 'export const answer = 42;\n', after: 'export const answer = 41;\n' },
            ]);
        } finally {
            await vscode.window.showTextDocument(document);
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });

    test('keeps spaces, non-ASCII names, and reserved address characters in source paths', async () => {
        const shown = await open(patchFile(formatPatch(repo, commit), 'naïve notes #1.patch'));
        assert.match(shown.title, /naïve notes #1/);
        assert.strictEqual(shown.resources.length, 3);
    });

    test('reads provider-backed patch addresses without treating them as local file paths', async () => {
        const content = Buffer.from(formatPatch(repo, commit));
        const changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        const denied = () => { throw vscode.FileSystemError.NoPermissions(); };
        const provider: vscode.FileSystemProvider = {
            onDidChangeFile: changed.event,
            watch: () => ({ dispose() {} }),
            stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.length }),
            readFile: () => content,
            readDirectory: () => { throw vscode.FileSystemError.FileNotADirectory(); },
            createDirectory: denied,
            writeFile: denied,
            delete: denied,
            rename: denied,
        };
        const registration = vscode.workspace.registerFileSystemProvider('review-remote-test', provider, {
            isReadonly: true,
        });
        try {
            const uri = vscode.Uri.from({
                scheme: 'review-remote-test', authority: 'example', path: '/saved patches/review #1.patch',
            });
            const shown = await open(uri);
            assert.strictEqual(shown.mode, 'complete');
            assert.strictEqual(shown.resources.length, 3);
            const [partial] = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', uri);
            assert.strictEqual(partial.id, shown.id);
            assert.strictEqual(partial.mode, 'partial');
            assert.strictEqual(api.reviews.list().length, 1);
        } finally {
            registration.dispose();
            changed.dispose();
        }
    });

    test('opens nothing for an inapplicable patch until a fallback is explicitly selected', async () => {
        const header = ['diff --git a/none.txt b/none.txt', '--- a/none.txt', '+++ b/none.txt'];
        const uri = patchFile([...header, '@@ -1 +1 @@', '-a', '+b', ''].join('\n'));
        assert.deepStrictEqual(await vscode.commands.executeCommand('viewPatch.open', uri), []);
        assert.strictEqual(api.reviews.documents.count, 0);
    });

    test('opens nothing for a file that is not a patch', async () => {
        assert.deepStrictEqual(await vscode.commands.executeCommand('viewPatch.open', patchFile('Notes.\n')), []);
    });
});

function settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('viewPatch');
}

async function readSides(shown: ShownPatch): Promise<Side[]> {
    const text = async (uri: string | undefined) =>
        uri === undefined ? undefined : (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText();
    const sides = await Promise.all(shown.resources.map(async ([label, before, after]) => {
        const uri = vscode.Uri.parse(label);
        const file = shown.repo ? path.relative(shown.repo, uri.fsPath).split(path.sep).join('/') : uri.path.slice(1);
        return { file, before: await text(before), after: await text(after) };
    }));
    return sides.sort((a, b) => a.file.localeCompare(b.file));
}

function allTabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs);
}

function reviewTabs(shown: ShownPatch): readonly vscode.Tab[] {
    return allTabs().filter(tab => tab.label.startsWith(shown.title)
        && !(tab.input instanceof vscode.TabInputTextDiff));
}

function describeTabs(): string {
    return allTabs().map(tab => {
        const input = tab.input;
        const type = input && typeof input === 'object' ? input.constructor.name : typeof input;
        const detail = input instanceof vscode.TabInputTextDiff
            ? ` ${input.original.toString()} -> ${input.modified.toString()}` : '';
        return `${tab.label} [${type}]${detail}`;
    }).join('\n');
}

function nodeLabel(node: vscode.TreeItem): string {
    return typeof node.label === 'string' ? node.label : node.label?.label ?? '';
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
