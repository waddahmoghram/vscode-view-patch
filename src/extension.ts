import * as vscode from 'vscode';
import { ReviewController } from './controller';
import { SCHEME } from './documents';

export type { ShownPatch } from './controller';
export interface ViewPatchApi {
    readonly reviews: ReviewController;
}

export function activate(context: vscode.ExtensionContext): ViewPatchApi {
    const log = vscode.window.createOutputChannel('View Patch', { log: true });
    const reviews = new ReviewController(log, context.globalState);
    context.subscriptions.push(
        log,
        reviews,
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, reviews.documents),
    );
    const commands: Record<string, (value?: unknown, selected?: unknown) => unknown | Promise<unknown>> = {
        'viewPatch.open': (uri, selected) => reviews.open(uri, selected),
        'viewPatch.openWith': uri => reviews.open(uri, undefined, 'choose'),
        'viewPatch.openHunks': (uri, selected) => reviews.open(uri, selected, 'partial'),
        'viewPatch.openSeries': (uri, selected) => reviews.openSeries(uri, selected),
        'viewPatch.refresh': value => reviews.refresh(value),
        'viewPatch.changeBase': value => reviews.changeBase(value),
        'viewPatch.showReview': value => reviews.showReview(value),
        'viewPatch.openFile': value => reviews.openFile(value),
        'viewPatch.toggleReviewed': value => reviews.toggleReviewed(value),
        'viewPatch.filter': value => reviews.filter(value),
        'viewPatch.clearFilter': () => reviews.filter(''),
        'viewPatch.closeReview': value => reviews.close(value),
        'viewPatch.showSummary': () => reviews.reveal(),
        'viewPatch.listReviews': () => reviews.list(),
        'viewPatch.openSample': () => reviews.openSample(),
        'viewPatch.openRecent': () => reviews.openRecent(),
        'viewPatch.copyDiagnostics': () => reviews.copyDiagnostics(),
        'viewPatch.exportSummary': value => reviews.exportSummary(value),
        'viewPatch.markAllReviewed': value => reviews.markAllReviewed(value),
        'viewPatch.clearReviewed': value => reviews.clearReviewed(value),
        'viewPatch.compareWith': (value, other) => reviews.compareWith(value, other),
        'viewPatch.openFromClipboard': () => reviews.openFromClipboard(),
        'viewPatch.reviewCommit': (repo, revision) => reviews.reviewCommit(repo, revision),
        'viewPatch.nextUnreviewed': value => reviews.nextUnreviewed(value),
        'viewPatch.previousUnreviewed': value => reviews.previousUnreviewed(value),
        'viewPatch.copyFileDiff': value => reviews.copyFileDiff(value),
    };
    for (const [command, handler] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(
            command, async (value?: unknown, selected?: unknown) => {
                try {
                    return await handler(value, selected);
                } catch (error) {
                    reviews.report(error);
                    return undefined;
                }
            },
        ));
    }

    const provider: vscode.CustomReadonlyEditorProvider = {
        openCustomDocument(uri) {
            return { uri, dispose() {} };
        },
        async resolveCustomEditor(document, panel) {
            panel.webview.html = '<!doctype html><html><head>'
                + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';">'
                + '</head><body><p>Opening the patch review...</p></body></html>';
            try {
                await reviews.open(document.uri);
            } finally {
                panel.dispose();
            }
        },
    };
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('viewPatch.editor', provider, {
        supportsMultipleEditorsPerDocument: false,
    }));
    return { reviews };
}
