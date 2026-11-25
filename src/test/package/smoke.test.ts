import * as assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
// Types only: loading the checkout's code at run time would test it instead of the installed package.
import type { ShownPatch } from '../../extension';
import { canonical, commitAll, formatPatch, git, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

const ID = 'waddahmoghram.view-patch';

// scripts/test-package.mjs installs a built .vsix into a fresh extensions folder and loads only an inert stub as
// the development extension, so these tests reach the installed copy through its public commands alone.
suite('Installed package', () => {
    let extension: vscode.Extension<unknown>;

    suiteSetup(async () => {
        const found = vscode.extensions.getExtension(ID);
        assert.ok(found, `${ID} is not installed`);
        extension = found;
        await extension.activate();
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const open = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.listReviews');
        for (const review of open) {
            await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: review.id });
        }
    });

    suiteTeardown(async () => {
        await settings().update('repositories', undefined, vscode.ConfigurationTarget.Global);
        await removeTempDirs();
    });

    test('activates the installed copy at the packaged version, not a development folder', () => {
        const extensions = process.env.VIEW_PATCH_EXTENSIONS_DIR;
        const expected = process.env.VIEW_PATCH_EXPECTED_VERSION;
        assert.ok(extensions && expected, 'run these tests with npm run test:package');
        assert.ok(canonical(extension.extensionPath).startsWith(canonical(extensions) + path.sep),
            `${extension.extensionPath} is not inside the temporary extensions folder ${extensions}`);
        assert.strictEqual(extension.packageJSON.version, expected);
        assert.strictEqual(extension.isActive, true);
        assert.strictEqual(existsSync(path.join(extension.extensionPath, 'out', 'test')), false,
            'the package must not contain the compiled tests');
        const checkout = canonical(path.resolve(__dirname, '..', '..', '..'));
        assert.deepStrictEqual(
            vscode.extensions.all.filter(entry => canonical(entry.extensionPath) === checkout).map(entry => entry.id),
            [], 'the repository must not be loaded as an extension');
    });

    test('opens the built-in sample as a review', async () => {
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openSample');
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'partial');
        assert.strictEqual(shown[0].resources.length, 2);
        const listed = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.listReviews');
        assert.deepStrictEqual(listed.map(review => review.id), [shown[0].id]);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
            .filter(tab => tab.label.startsWith(shown[0].title) && !(tab.input instanceof vscode.TabInputTextDiff));
        assert.strictEqual(tabs.length, 1, 'the review did not open one Changes tab');
        const after = shown[0].resources[0][2];
        assert.ok(after);
        assert.notStrictEqual((await vscode.workspace.openTextDocument(vscode.Uri.parse(after))).getText(), '');
    });

    test('opens a patch as complete files and leaves its repository unchanged', async () => {
        const repo = makeRepo({ 'notes/list.txt': 'apples\npears\n' });
        writeFiles(repo, { 'notes/list.txt': 'apples\nplums\n' });
        const commit = commitAll(repo, 'Change the list');
        const file = path.join(tempDir(), 'change.patch');
        writeFileSync(file, formatPatch(repo, commit));
        await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
        const before = repositoryState(repo);
        assert.strictEqual(before.status, '');

        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', vscode.Uri.file(file));
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'complete');
        assert.ok(shown[0].repo);
        assert.strictEqual(canonical(shown[0].repo), canonical(repo));
        assert.strictEqual(shown[0].base, `${commit}^`);
        assert.deepStrictEqual(await readSides(shown[0]), [['apples\npears\n', 'apples\nplums\n']]);
        const other = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openSample');
        const partial = await vscode.commands.executeCommand<ShownPatch>(
            'viewPatch.showHunks', { reviewId: shown[0].id });
        assert.strictEqual(partial.id, shown[0].id);
        assert.strictEqual(partial.mode, 'partial');
        assert.match((await readSides(partial))[0][0] ?? '', /partial/i);
        const complete = await vscode.commands.executeCommand<ShownPatch>(
            'viewPatch.showCompleteFiles', { reviewId: partial.id });
        assert.strictEqual(complete.id, shown[0].id);
        assert.strictEqual(complete.mode, 'complete');
        assert.deepStrictEqual(await readSides(complete), [['apples\npears\n', 'apples\nplums\n']]);
        const environment = await vscode.commands.executeCommand<string>('viewPatch.showEnvironment');
        assert.match(environment, /Running on: local (Windows|macOS|Linux)/);
        await vscode.commands.executeCommand('viewPatch.showOutput');
        const reviews = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.listReviews');
        assert.deepStrictEqual(reviews.map(review => review.id).sort(), [shown[0].id, other[0].id].sort());
        assert.deepStrictEqual(repositoryState(repo), before);
    });

    test('opens a repository-free patch hunks-only as a partial review', async () => {
        const file = path.join(tempDir(), 'orphan.patch');
        writeFileSync(file, [
            'diff --git a/greeting.txt b/greeting.txt',
            '--- a/greeting.txt',
            '+++ b/greeting.txt',
            '@@ -1,2 +1,2 @@',
            ' hello',
            '-old line',
            '+new line',
            '',
        ].join('\n'));
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', vscode.Uri.file(file));
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'partial');
        assert.strictEqual(shown[0].repo, undefined);
        assert.match(shown[0].title, /partial context/);
        const [[before, after]] = await readSides(shown[0]);
        assert.match(before ?? '', /partial/i);
        assert.match(after ?? '', /new line/);
    });
});

function settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('viewPatch');
}

async function readSides(shown: ShownPatch): Promise<(string | undefined)[][]> {
    const text = async (uri: string | undefined) =>
        uri === undefined ? undefined : (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText();
    return Promise.all(shown.resources.map(async ([, before, after]) => [await text(before), await text(after)]));
}

/** What a review must not change: the working tree and index status, HEAD, refs, the index file, and objects. */
function repositoryState(repo: string) {
    const gitPath = (name: string) => path.resolve(repo, git(repo, 'rev-parse', '--git-path', name).trim());
    const objects = gitPath('objects');
    return {
        status: git(repo, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
        head: git(repo, 'rev-parse', 'HEAD').trim(),
        refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
        index: createHash('sha256').update(readFileSync(gitPath('index'))).digest('hex'),
        looseObjects: readdirSync(objects).filter(name => /^[0-9a-f]{2}$/.test(name))
            .flatMap(folder => readdirSync(path.join(objects, folder)).map(name => folder + name)).sort(),
        counts: git(repo, 'count-objects', '-v'),
    };
}
