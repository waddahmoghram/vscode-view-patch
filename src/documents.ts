import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileChange, isBinary } from './patch';

export const SCHEME = 'view-patch';

/** One file of a Changes view: its place in the repository, then its before and after documents. */
export type ChangeResource = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

type Side = 'before' | 'after';

/**
 * Serves the sides of shown patches from memory as read-only documents. Only the most recent views are kept; a
 * document from an older view says so instead of showing content that may no longer match the patch.
 */
export class PatchDocuments implements vscode.TextDocumentContentProvider {
    private readonly views = new Map<string, Map<string, Buffer>>();

    constructor(private readonly keep = 20) {}

    /** Stores both sides of each change made in `repo` and returns the resources for `vscode.changes`. */
    add(repo: string, changes: readonly FileChange[]): ChangeResource[] {
        const view = randomBytes(8).toString('hex');
        const files = new Map<string, Buffer>();
        const store = (side: Side, file: string, content: Buffer | undefined): vscode.Uri | undefined => {
            if (content === undefined) {
                return undefined;
            }
            const query = new URLSearchParams({ view, side }).toString();
            const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query });
            files.set(fileKey(uri), content);
            return uri;
        };
        const resources = changes.map((change): ChangeResource => [
            vscode.Uri.file(path.join(repo, change.newPath)),
            store('before', change.oldPath, change.before),
            store('after', change.newPath, change.after),
        ]);

        this.views.set(view, files);
        for (const old of this.views.keys()) {
            if (this.views.size <= this.keep) {
                break;
            }
            this.views.delete(old);
        }
        return resources;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const view = new URLSearchParams(uri.query).get('view') ?? '';
        const content = this.views.get(view)?.get(fileKey(uri));
        if (content === undefined) {
            return 'This file belonged to an earlier View Patch view. Run "View Patch: Open Patch as Changes" again.\n';
        }
        return isBinary(content) ? `Binary file, ${content.length} bytes.\n` : content.toString('utf8');
    }
}

function fileKey(uri: vscode.Uri): string {
    return `${new URLSearchParams(uri.query).get('side')}:${uri.path}`;
}
