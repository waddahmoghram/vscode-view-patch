// The browser-platform suite that scripts/test-web.mjs runs inside VS Code for the Web
// (headless chromium via @vscode/test-web). This file is bundled by esbuild.webtest.mjs for
// the web extension host worker, so it must not import Node built-ins - including 'assert',
// which the local check() helper replaces. The mocha tdd globals (suite/test/...) come from
// the mocha browser build that the bundle entry loads.
import * as vscode from 'vscode';
import type { ShownPatch, ViewPatchApi } from '../../extension';

function check(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function diffText(marker: string): string {
    return [
        `diff --git a/${marker}.txt b/${marker}.txt`,
        `--- a/${marker}.txt`,
        `+++ b/${marker}.txt`,
        '@@ -1,2 +1,2 @@',
        ' hello',
        '-old line',
        '+new line',
        '',
    ].join('\n');
}

function openDiffDocument(marker: string): Thenable<vscode.TextDocument> {
    return vscode.workspace.openTextDocument({ language: 'diff', content: diffText(marker) });
}

async function providerText(uri: string | undefined): Promise<string | undefined> {
    return uri === undefined ? undefined
        : (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText();
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        check(Date.now() < deadline, message);
        await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
}

suite('View Patch in the web extension host', () => {
    let api: ViewPatchApi;

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension<ViewPatchApi>('waddahmoghram.view-patch');
        check(extension, 'the extension is not installed in the web host');
        api = await extension.activate();
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.reviews.documents.count === 0, 'closed reviews did not release their content');
    });

    test('activates and exposes the review controller', () => {
        check(typeof api.reviews.list === 'function',
            'activate() must return the ViewPatchApi with the review controller');
        check(api.reviews.list().length === 0, 'the fresh web host must start with no reviews');
    });

    test('openHunks on untitled diff text shows one partial review with readable sides', async () => {
        const document = await openDiffDocument('greeting');
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', document.uri);
        check(shown.length === 1, `expected one review, got ${shown.length}`);
        check(shown[0].mode === 'partial', `expected a partial review, got ${shown[0].mode}`);
        check(shown[0].repo === undefined, 'a hunk-only review must not claim a repository');
        check(shown[0].resources.length === 1, `expected one changed file, got ${shown[0].resources.length}`);
        const [label, beforeUri, afterUri] = shown[0].resources[0];
        check(vscode.Uri.parse(label).path === '/greeting.txt', `unexpected resource label: ${label}`);
        const before = await providerText(beforeUri);
        const after = await providerText(afterUri);
        check(before !== undefined && before.includes('old line'), 'the before side must show the removed line');
        check(/partial/i.test(before), 'the before side must state that its context is partial');
        check(after !== undefined && after.includes('new line'), 'the after side must show the added line');
        check(!after.includes('old line'), 'the after side must not keep the removed line');
    });

    test('opening a patch on the web goes straight to hunks, because the web host cannot run Git', async () => {
        const document = await openDiffDocument('fallback');
        for (const command of ['viewPatch.open', 'viewPatch.openWith']) {
            const shown = await vscode.commands.executeCommand<ShownPatch[]>(command, document.uri);
            check(Array.isArray(shown) && shown.length === 1, `${command} must open one review on the web`);
            check(shown[0].mode === 'partial', `${command} must open a hunk-only review on the web`);
        }
    });

    test('reviewing a commit on the web declines with the reason instead of attempting Git', async () => {
        let message = '';
        try {
            await api.reviews.reviewCommit();
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        check(message.includes('VS Code for the Web cannot run Git.'), `the refusal must name the reason: ${message}`);
    });

    test('the sample command opens a partial review', async () => {
        const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openSample');
        check(shown.length === 1, 'the sample must open exactly one review');
        check(shown[0].mode === 'partial', 'the sample opens hunk-only, so it must be partial');
        check(shown[0].resources.length > 0, 'the sample must show at least one changed file');
    });

    test('diagnostics are produced without Node globals, for bug reports from the web', async () => {
        const text = await vscode.commands.executeCommand<string>('viewPatch.copyDiagnostics');
        check(typeof text === 'string' && text.startsWith('View Patch '), 'diagnostics must start with the version');
        check(/^Platform: browser \(no Node\.js\)$/m.test(text), `the platform line must name the browser:\n${text}`);
        check(/^Git executable: \(none\)$/m.test(text), `no Git executable applies on the web:\n${text}`);
        check(/^Git version: unavailable: VS Code for the Web cannot run Git\.$/m.test(text),
            `the Git line must give the real reason:\n${text}`);
    });
});
