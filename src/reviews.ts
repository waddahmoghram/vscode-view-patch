import * as path from 'path';
import * as vscode from 'vscode';
import { contentFingerprint, isDisplayableText, SnapshotFile, SnapshotSection } from './documents';
import type { PatchMetadata } from './patchText';

export interface ReviewSource {
    readonly uri: vscode.Uri;
    readonly name: string;
    readonly members?: readonly vscode.Uri[];
    readonly memberDigests?: ReadonlyMap<string, string>;
}

export interface ReviewSection extends SnapshotSection {
    readonly label: string;
    readonly metadata?: PatchMetadata;
}

export interface ReviewData {
    readonly source: ReviewSource;
    readonly mode: 'complete' | 'partial';
    readonly digest: string;
    readonly sections: readonly ReviewSection[];
    readonly repo?: string;
    readonly base?: string;
    readonly baseTree?: string;
    readonly metadata?: PatchMetadata;
}

export interface Review extends ReviewData {
    readonly id: string;
    readonly title: string;
    readonly reviewed: Set<string>;
    section: string;
    opening: boolean;
    seen: boolean;
    sourceChanged?: boolean;
    lastOpened?: number;
}

export interface ReviewReference {
    readonly reviewId: string;
    readonly sectionKey?: string;
    readonly fileIndex?: number;
}

export class ReviewNode extends vscode.TreeItem implements ReviewReference {
    constructor(
        readonly kind: 'review' | 'section' | 'details' | 'file' | 'info',
        readonly reviewId: string,
        label: string,
        readonly sectionKey?: string,
        readonly fileIndex?: number,
    ) {
        super(label, kind === 'review' || kind === 'section' ? vscode.TreeItemCollapsibleState.Expanded
            : kind === 'details' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    }
}

export class ReviewTree implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<ReviewNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    filter = '';

    constructor(private readonly reviews: ReadonlyMap<string, Review>) {}

    getTreeItem(element: ReviewNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ReviewNode): ReviewNode[] {
        if (!element) {
            return [...this.reviews.values()].map(review => this.root(review));
        }
        const review = this.reviews.get(element.reviewId);
        if (!review) {
            return [];
        }
        if (element.kind === 'review') {
            const info = this.summary(review);
            return info.concat(review.sections.length === 1
                ? this.files(review, review.sections[0])
                : review.sections.map(section => this.section(review, section)));
        }
        if (element.kind === 'section') {
            const section = review.sections.find(item => item.key === element.sectionKey);
            return section ? this.files(review, section) : [];
        }
        if (element.kind === 'details') {
            return this.details(review);
        }
        return [];
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    dispose(): void {
        this.changed.dispose();
    }

    private root(review: Review): ReviewNode {
        const root = new ReviewNode('review', review.id, review.source.name);
        root.id = review.id;
        root.contextValue = 'viewPatch.review';
        root.iconPath = new vscode.ThemeIcon(review.mode === 'partial' ? 'warning' : 'diff-multiple');
        const sections = summarySections(review);
        const files = sections.flatMap(section => section.files);
        const checked = sections.reduce((count, section) => count + section.files.filter(
            file => review.reviewed.has(reviewFileKey(section.key, file)),
        ).length, 0);
        const series = review.sections.filter(section => section.key !== 'combined').length;
        const prefix = series > 1 ? `${series} patches; ` : '';
        root.description = `${prefix}${files.length} changes, ${checked} reviewed`
            + `${review.sourceChanged ? '; source changed' : ''}`;
        root.tooltip = `${review.title}\n${review.mode === 'partial' ? 'Partial context only' : review.repo ?? ''}`;
        root.command = { command: 'viewPatch.showReview', title: 'Show Review', arguments: [{ reviewId: review.id }] };
        return root;
    }

    private summary(review: Review): ReviewNode[] {
        const info: [string, string][] = [];
        if (review.sourceChanged) {
            info.push(['warning', 'The source patch changed. Refresh to review its latest contents.']);
        }
        if (review.mode === 'partial') {
            info.push(['warning', 'Partial context only: these are patch hunks, not complete files.']);
        } else {
            info.push(['repo', `Repository: ${review.repo}`]);
            info.push(['git-commit', `Base: ${review.base}`]);
        }
        const nodes = this.info(review, info, 'summary');
        const details = new ReviewNode('details', review.id, 'Review Details');
        details.id = `${review.id}:details`;
        details.iconPath = new vscode.ThemeIcon('info');
        nodes.push(details);
        return nodes;
    }

    private details(review: Review): ReviewNode[] {
        const info: [string, string][] = [];
        const metadata = review.sections.find(section => section.key === review.section)?.metadata ?? review.metadata;
        if (review.baseTree) {
            info.push(['git-commit', `Snapshot tree: ${review.baseTree}`]);
        }
        if (metadata?.subject) {
            info.push(['comment', `Subject: ${metadata.subject}`]);
        }
        if (metadata?.author) {
            info.push(['person', `Author: ${metadata.author}`]);
        }
        if (metadata?.date) {
            info.push(['calendar', `Date: ${metadata.date}`]);
        }
        const files = summarySections(review).flatMap(section => section.files);
        info.push(['list-unordered', describeCounts(files)]);
        return this.info(review, info, 'detail');
    }

    private info(review: Review, info: readonly [string, string][], kind: string): ReviewNode[] {
        return info.map(([icon, text], index) => {
            const item = new ReviewNode('info', review.id, text);
            item.id = `${review.id}:${kind}:${index}`;
            item.iconPath = new vscode.ThemeIcon(icon);
            item.tooltip = text;
            return item;
        });
    }

    private section(review: Review, section: ReviewSection): ReviewNode {
        const item = new ReviewNode('section', review.id, section.label, section.key);
        item.id = `${review.id}:section:${section.key}`;
        item.contextValue = 'viewPatch.section';
        item.collapsibleState = review.section === section.key
            ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.description = `${section.files.length} changes`;
        item.tooltip = section.metadata?.subject ?? section.label;
        item.command = {
            command: 'viewPatch.showReview',
            title: 'Show Patch',
            arguments: [{ reviewId: review.id, sectionKey: section.key }],
        };
        return item;
    }

    private files(review: Review, section: ReviewSection): ReviewNode[] {
        const needle = this.filter.toLocaleLowerCase();
        const files: ReviewNode[] = [];
        for (const [index, file] of section.files.entries()) {
            if (needle && !`${file.oldPath}\n${file.newPath}`.toLocaleLowerCase().includes(needle)) {
                continue;
            }
            const reviewed = review.reviewed.has(reviewFileKey(section.key, file));
            const item = new ReviewNode('file', review.id, file.newPath, section.key, index);
            item.id = `${review.id}:${reviewFileKey(section.key, file)}`;
            item.description = `${file.status}${reviewed ? ' | reviewed' : ''}${fileDetail(file)}`;
            item.contextValue = reviewed ? 'viewPatch.file.reviewed' : 'viewPatch.file.unreviewed';
            item.iconPath = new vscode.ThemeIcon(reviewed ? 'pass' : 'circle-outline');
            item.tooltip = `${file.oldPath === file.newPath ? file.newPath : `${file.oldPath} -> ${file.newPath}`}`
                + `\n${file.note ?? fileDetail(file).replace(/^ \| /, '')}`;
            item.command = {
                command: 'viewPatch.openFile',
                title: 'Open File Difference',
                arguments: [{ reviewId: review.id, sectionKey: section.key, fileIndex: index }],
            };
            files.push(item);
        }
        if (files.length === 0 && needle) {
            files.push(new ReviewNode('info', review.id, `No paths match "${this.filter}".`));
        }
        return files;
    }
}

export function primarySection(review: ReviewData): ReviewSection | undefined {
    return review.sections.find(section => section.key === 'combined') ?? review.sections[0];
}

function summarySections(review: ReviewData): readonly ReviewSection[] {
    const combined = review.sections.find(section => section.key === 'combined');
    return combined ? [combined] : review.sections;
}

export function reviewFileKey(section: string, file: SnapshotFile): string {
    return `${section}\0${file.oldPath}\0${file.newPath}`;
}

export function preserveReviewed(previous: Review, next: ReviewData): Set<string> {
    const old = new Map<string, string>();
    for (const section of previous.sections) {
        for (const file of section.files) {
            old.set(reviewFileKey(section.key, file), fileSignature(file));
        }
    }
    const reviewed = new Set<string>();
    for (const section of next.sections) {
        for (const file of section.files) {
            const key = reviewFileKey(section.key, file);
            if (previous.reviewed.has(key) && old.get(key) === fileSignature(file)) {
                reviewed.add(key);
            }
        }
    }
    return reviewed;
}

export function reviewReference(value: unknown): ReviewReference | undefined {
    if (!value || typeof value !== 'object' || !('reviewId' in value) || typeof value.reviewId !== 'string') {
        return undefined;
    }
    const sectionKey = 'sectionKey' in value && typeof value.sectionKey === 'string' ? value.sectionKey : undefined;
    const fileIndex = 'fileIndex' in value && typeof value.fileIndex === 'number' ? value.fileIndex : undefined;
    return { reviewId: value.reviewId, sectionKey, fileIndex };
}

function describeCounts(files: readonly SnapshotFile[]): string {
    const count = (status: string) => files.filter(file => file.status === status).length;
    const counts = [
        ['added', count('A')], ['modified', count('M')], ['deleted', count('D')],
        ['renamed', count('R')], ['copied', count('C')], ['type changed', count('T')],
    ].filter(([, value]) => value !== 0);
    return counts.length ? counts.map(([label, value]) => `${value} ${label}`).join(', ') : 'No file changes.';
}

function fileDetail(file: SnapshotFile): string {
    if (file.note) {
        return ` | ${file.note}`;
    }
    if (file.kind === 'metadata') {
        return ' | metadata only';
    }
    const sides = [file.before, file.after].filter((side): side is Buffer => side !== undefined);
    if (sides.some(side => !isDisplayableText(side))) {
        return ` | binary: ${file.before?.length ?? 0} -> ${file.after?.length ?? 0} bytes`;
    }
    const renamed = file.oldPath !== file.newPath ? ` | from ${file.oldPath}` : '';
    const mode = file.oldMode && file.newMode && file.oldMode !== file.newMode
        ? ` | mode ${file.oldMode} -> ${file.newMode}` : '';
    return renamed + mode;
}

function fileSignature(file: SnapshotFile): string {
    const fingerprint = (content?: Buffer) => content === undefined ? '-' : contentFingerprint(content);
    return `${file.status}:${file.kind}:${file.note}:${file.oldMode}:${file.newMode}`
        + `:${fingerprint(file.before)}:${fingerprint(file.after)}`;
}

export function reviewTitle(name: string, number: number, mode: ReviewData['mode']): string {
    return `${path.basename(name)} [Patch ${number}${mode === 'partial' ? ': partial context' : ''}]`;
}
