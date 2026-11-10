import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_MAX_CACHE_BYTES, OperationLimitError, positiveLimit } from './operations';
import type { FileChange } from './patch';

export const SCHEME = 'view-patch';
export type ChangeResource = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];
type Side = 'before' | 'after';

export interface SnapshotFile extends FileChange {
    readonly kind?: 'content' | 'metadata';
    readonly note?: string;
}

export interface SnapshotSection {
    readonly key: string;
    readonly files: readonly SnapshotFile[];
}

interface StoredDocument {
    readonly bytes: Buffer;
    readonly kind: 'content' | 'metadata';
}

interface Snapshot {
    readonly sections: ReadonlyMap<string, SnapshotSection>;
    readonly documents: ReadonlyMap<string, StoredDocument>;
}

export class PatchDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly views = new Map<string, Snapshot>();
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;
    private limit: number;

    constructor(maxBytes = DEFAULT_MAX_CACHE_BYTES) {
        this.limit = positiveLimit('Open content limit', maxBytes);
    }

    get bytes(): number {
        return snapshotBytes(this.views.values());
    }

    get count(): number {
        return this.views.size;
    }

    setLimit(bytes: number): void {
        this.limit = positiveLimit('Open content limit', bytes);
    }

    replace(id: string, sections: readonly SnapshotSection[], retainedUris?: ReadonlySet<string>): void {
        const documents = new Map<string, StoredDocument>();
        for (const section of sections) {
            for (const file of section.files) {
                for (const side of ['before', 'after'] as const) {
                    const bytes = file[side];
                    if (bytes !== undefined) {
                        documents.set(documentUri(id, section.key, file, side).toString(), {
                            bytes,
                            kind: file.kind ?? 'content',
                        });
                    }
                }
            }
        }
        const previous = this.views.get(id);
        const keep = retainedUris ?? new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));
        for (const [uri, content] of previous?.documents ?? []) {
            if (!documents.has(uri) && keep.has(uri)) {
                documents.set(uri, content);
            }
        }
        const snapshot: Snapshot = {
            sections: new Map(sections.map(section => [section.key, section])),
            documents,
        };
        const proposed = new Map(this.views);
        proposed.set(id, snapshot);
        const bytes = snapshotBytes(proposed.values());
        if (bytes > this.limit) {
            throw new OperationLimitError(
                `Open patch content would use ${bytes} bytes; the limit is ${this.limit} bytes. `
                + 'Close a patch review or raise viewPatch.maxOpenContentMiB.',
            );
        }
        this.views.set(id, snapshot);
        for (const [uri, content] of documents) {
            if (previous?.documents.get(uri)?.bytes !== content.bytes) {
                this.changed.fire(vscode.Uri.parse(uri));
            }
        }
    }

    resources(id: string, sectionKey: string, repo?: string): ChangeResource[] {
        return this.section(id, sectionKey).files.map(file => [
            repo ? vscode.Uri.file(path.join(repo, file.newPath)) : vscode.Uri.from({
                scheme: SCHEME,
                path: virtualPath(file.newPath),
                query: new URLSearchParams({ view: id, section: sectionKey, label: 'true' }).toString(),
            }),
            file.before === undefined ? undefined : documentUri(id, sectionKey, file, 'before'),
            file.after === undefined ? undefined : documentUri(id, sectionKey, file, 'after'),
        ]);
    }

    fileResources(id: string, sectionKey: string, index: number, repo?: string): ChangeResource {
        const section = this.section(id, sectionKey);
        const file = section.files[index];
        if (!file) {
            throw new Error('That file is no longer in this review. Select it from Patch Reviews again.');
        }
        return this.resources(id, sectionKey, repo)[index];
    }

    emptyUri(id: string, file: string): vscode.Uri {
        return vscode.Uri.from({
            scheme: SCHEME,
            path: virtualPath(file),
            query: new URLSearchParams({ view: id, empty: 'true' }).toString(),
        });
    }

    remove(id: string): void {
        this.views.delete(id);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        if (new URLSearchParams(uri.query).get('empty') === 'true') {
            return '';
        }
        const id = snapshotId(uri);
        const content = id && this.views.get(id)?.documents.get(uri.toString());
        if (!content) {
            return 'This file belonged to a closed View Patch review. Open the patch again from Patch Reviews.\n';
        }
        return content.kind === 'metadata' ? content.bytes.toString('utf8') : renderContent(content.bytes);
    }

    // Kept for consumers that only need to show a one-off set of changes.
    add(repo: string, changes: readonly FileChange[]): ChangeResource[] {
        const id = randomBytes(8).toString('hex');
        this.replace(id, [{ key: 'combined', files: changes }]);
        return this.resources(id, 'combined', repo);
    }

    dispose(): void {
        this.views.clear();
        this.changed.dispose();
    }

    private section(id: string, key: string): SnapshotSection {
        const section = this.views.get(id)?.sections.get(key);
        if (!section) {
            throw new Error('That patch review has closed. Open the patch again.');
        }
        return section;
    }
}

export function snapshotId(uri: vscode.Uri): string | undefined {
    return uri.scheme === SCHEME ? new URLSearchParams(uri.query).get('view') ?? undefined : undefined;
}

export function contentFingerprint(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export function renderContent(bytes: Buffer): string {
    const bom = byteOrderMark(bytes);
    if (bom) {
        try {
            const text = new TextDecoder(bom.encoding, { fatal: true }).decode(bytes);
            return `Encoding: ${bom.encoding} (byte-order mark)\n\n${text}`;
        } catch (error) {
            if (!(error instanceof TypeError)) {
                throw error;
            }
        }
    } else if (!bytes.subarray(0, 8000).includes(0)) {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
            if (!(error instanceof TypeError)) {
                throw error;
            }
        }
    }
    return `Binary or undecodable content; ${bytes.length} bytes.\n`
        + `Content fingerprint: ${contentFingerprint(bytes)}\n`
        + 'This placeholder does not display the file bytes.\n';
}

export function isDisplayableText(bytes: Buffer): boolean {
    const encoding = byteOrderMark(bytes)?.encoding;
    if (!encoding && bytes.subarray(0, 8000).includes(0)) {
        return false;
    }
    try {
        new TextDecoder(encoding ?? 'utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }
        return false;
    }
}

function documentUri(id: string, section: string, file: SnapshotFile, side: Side): vscode.Uri {
    return vscode.Uri.from({
        scheme: SCHEME,
        path: virtualPath(side === 'before' ? file.oldPath : file.newPath),
        query: new URLSearchParams({
            view: id,
            section,
            file: `${file.oldPath}\0${file.newPath}`,
            side,
        }).toString(),
    });
}

function virtualPath(file: string): string {
    return `/${file.replace(/^\/+/, '')}`;
}

function snapshotBytes(snapshots: Iterable<Snapshot>): number {
    const buffers = new Set<Buffer>();
    for (const snapshot of snapshots) {
        for (const document of snapshot.documents.values()) {
            buffers.add(document.bytes);
        }
    }
    let bytes = 0;
    for (const buffer of buffers) {
        bytes += buffer.length;
    }
    return bytes;
}

function byteOrderMark(bytes: Buffer): { encoding: string } | undefined {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { encoding: 'utf-8' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { encoding: 'utf-16le' };
    }
    return bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? { encoding: 'utf-16be' } : undefined;
}
