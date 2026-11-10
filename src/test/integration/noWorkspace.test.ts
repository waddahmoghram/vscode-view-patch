import * as assert from 'assert';
import { writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ShownPatch, ViewPatchApi } from '../../extension';
import { canonical, commitAll, formatPatch, makeRepo, removeTempDirs, tempDir, writeFiles } from '../helpers';

interface Side {
    file: string;
    before?: string;
    after?: string;
}

// The test editor opens no folder, so this suite pins the empty-window contract: with no workspace
// folder and no viewPatch.repositories entries, complete reviews must find the repository through
// the patch file's own folder, and hunk-only reviews must need no repository at all.
suite('Empty window without configured repositories', () => {
    let api: ViewPatchApi;

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension<ViewPatchApi>('waddahmoghram.view-patch');
        assert.ok(extension);
        api = await extension.activate();
        await settings().update('repositories', undefined, vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.reviews.documents.count === 0, 'closed reviews did not release their content');
    });

    suiteTeardown(async () => {
        await removeTempDirs();
    });

    test('runs with no workspace folder and no configured repositories', () => {
        assert.strictEqual(vscode.workspace.workspaceFolders, undefined,
            'these tests must run in an empty window; remove the workspace folder from the test configuration');
        assert.deepStrictEqual(settings().get('repositories'), [],
            'viewPatch.repositories must be empty for this suite');
    });

    test("finds the repository through the patch file's own folder", async () => {
        const repo = makeRepo({ 'src/value.txt': 'one\n' });
        writeFiles(repo, { 'src/value.txt': 'two\n' });
        const commit = commitAll(repo, 'Change the value');
        writeFiles(repo, { 'patches/change.patch': formatPatch(repo, commit) });
        const uri = vscode.Uri.file(path.join(repo, 'patches', 'change.patch'));
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', uri);
        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].mode, 'complete');
        assert.ok(shown[0].repo);
        assert.strictEqual(canonical(shown[0].repo), canonical(repo));
        assert.strictEqual(shown[0].base, `${commit}^`);
        assert.deepStrictEqual(await readSides(shown[0]), [
            { file: 'src/value.txt', before: 'one\n', after: 'two\n' },
        ]);
    });

    test('opens explicitly partial hunks with no repository anywhere', async () => {
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
        const [side] = await readSides(shown[0]);
        assert.match(side.before ?? '', /partial/i);
        assert.match(side.after ?? '', /new line/);
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
