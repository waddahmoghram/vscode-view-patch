import * as assert from 'assert';
import { writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ShownPatch } from '../../extension';
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

    suiteSetup(async () => {
        await vscode.extensions.getExtension('waddahmoghram.view-patch')?.activate();
        repo = makeRepo({ 'src/app.ts': 'export const answer = 41;\n', 'notes.md': '# Notes\n', 'old.txt': 'old\n' });
        writeFiles(repo, { 'src/app.ts': 'export const answer = 42;\n', 'docs/new.md': '# New\n', 'old.txt': null });
        commit = commitAll(repo, 'Change the answer');
        scratch = tempDir();
        await settings().update('repositories', [repo], vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async () => {
        await settings().update('repositories', undefined, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        removeTempDirs();
    });

    test('opens every file of a format-patch file in one Changes tab', async () => {
        const patchFile = path.join(scratch, 'change.patch');
        writeFileSync(patchFile, formatPatch(repo, commit));

        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', vscode.Uri.file(patchFile));

        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].title, 'change.patch');
        assert.strictEqual(canonical(shown[0].repo), canonical(repo));
        assert.strictEqual(shown[0].base, `${commit}^`);
        assert.deepStrictEqual(await readSides(shown[0]), [
            { file: 'docs/new.md', before: undefined, after: '# New\n' },
            { file: 'old.txt', before: 'old\n', after: undefined },
            { file: 'src/app.ts', before: 'export const answer = 41;\n', after: 'export const answer = 42;\n' },
        ]);
        // VS Code versions that count the files show "change.patch (3 files)".
        const isOurs = (tab: vscode.Tab) => tab.label === shown[0].title || tab.label === `${shown[0].title} (3 files)`;
        const opened = await waitFor(() => allTabs().some(isOurs));
        assert.ok(opened, `no "${shown[0].title}" tab; open tabs: ${allTabs().map(describeTab).join('; ') || 'none'}`);
    });

    test('opens unsaved patch text from the active editor', async () => {
        const reverse = git(repo, 'diff', commit, `${commit}^`, '--', 'src/app.ts');
        const document = await vscode.workspace.openTextDocument({ language: 'diff', content: reverse });
        await vscode.window.showTextDocument(document);

        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open');

        assert.strictEqual(shown.length, 1);
        assert.strictEqual(shown[0].base, 'HEAD');
        assert.deepStrictEqual(await readSides(shown[0]), [
            { file: 'src/app.ts', before: 'export const answer = 42;\n', after: 'export const answer = 41;\n' },
        ]);
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    test('opens nothing for a patch that applies nowhere', async () => {
        const patchFile = path.join(scratch, 'stray.diff');
        const header = ['diff --git a/none.txt b/none.txt', '--- a/none.txt', '+++ b/none.txt'];
        writeFileSync(patchFile, [...header, '@@ -1 +1 @@', '-a', '+b', ''].join('\n'));

        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', vscode.Uri.file(patchFile));

        assert.deepStrictEqual(shown, []);
    });

    test('opens nothing for a file that is not a patch', async () => {
        const textFile = path.join(scratch, 'notes.patch');
        writeFileSync(textFile, 'Not a patch at all.\n');

        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', vscode.Uri.file(textFile));

        assert.deepStrictEqual(shown, []);
    });

    test('a document from an earlier view asks to open the patch again', async () => {
        const stale = vscode.Uri.from({ scheme: 'view-patch', path: '/src/app.ts', query: 'view=gone&side=after' });
        const document = await vscode.workspace.openTextDocument(stale);
        assert.match(document.getText(), /earlier View Patch view/);
    });
});

function settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('viewPatch');
}

async function readSides(shown: ShownPatch): Promise<Side[]> {
    const text = async (uri: string | undefined) =>
        uri === undefined ? undefined : (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText();
    const sides = await Promise.all(
        shown.resources.map(async ([label, before, after]) => ({
            file: path.relative(shown.repo, vscode.Uri.parse(label).fsPath).split(path.sep).join('/'),
            before: await text(before),
            after: await text(after),
        })),
    );
    return sides.sort((a, b) => a.file.localeCompare(b.file));
}

function allTabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs);
}

function describeTab(tab: vscode.Tab): string {
    const input = tab.input as { constructor?: { name?: string } } | undefined;
    return `${tab.label} (${input?.constructor?.name ?? typeof input})`;
}

async function waitFor(check: () => boolean, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return true;
}
