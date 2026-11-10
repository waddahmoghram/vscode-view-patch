import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ShownPatch, ViewPatchApi } from '../../extension';

export async function run(): Promise<void> {
    const root = process.env.VIEW_PATCH_RESTRICTED_ROOT;
    assert.ok(root, 'the restricted test profile was not supplied');
    assert.strictEqual(vscode.workspace.isTrusted, false, 'the test must run in real Restricted Mode');
    const extension = vscode.extensions.getExtension<ViewPatchApi>('waddahmoghram.view-patch');
    assert.ok(extension);
    await extension.activate();
    const file = path.join(root, 'review.patch');
    await fs.writeFile(file, [
        'diff --git a/example.txt b/example.txt',
        '--- a/example.txt',
        '+++ b/example.txt',
        '@@ -10 +10 @@',
        '-before',
        '+after',
        '',
    ].join('\n'));
    const blocked = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.open', vscode.Uri.file(file));
    assert.deepStrictEqual(blocked, [], 'Git-backed viewing must not run in an untrusted workspace');
    const shown = await vscode.commands.executeCommand<ShownPatch[]>('viewPatch.openHunks', vscode.Uri.file(file));
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].mode, 'partial');
    assert.strictEqual(shown[0].repo, undefined);
    assert.match(shown[0].title, /partial context/);
    const after = shown[0].resources[0][2];
    assert.ok(after);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(after));
    assert.match(document.getText(), /partial/i);
    assert.match(document.getText(), /after/);
    assert.strictEqual(extension.isActive, true);
    await vscode.commands.executeCommand('viewPatch.closeReview', { reviewId: shown[0].id });
    assert.strictEqual(extension.exports.reviews.documents.count, 0);
    console.log('PASS: real Restricted Mode blocks Git-backed viewing and permits explicit hunk-only reviews.');
}
