import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { contentFingerprint, PatchDocuments, SCHEME, snapshotId, SnapshotFile } from './documents';
import { Git } from './git';
import {
    DEFAULT_MAX_CACHE_BYTES,
    DEFAULT_MAX_CONTENT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_PATCH_BYTES,
    DEFAULT_TIMEOUT_MS,
    OperationCancelledError,
    OperationLimitError,
    OperationOptions,
    positiveLimit,
    throwIfAborted,
} from './operations';
import { AppliedPatch, applyPatch, ChangeStatus, commitChanges, compareApplied, FileDiffInput, fileDiffStats, looksLikePatch, mergeChanges, patchCommit, SkippedChange, unifiedFileDiff } from './patch';
import { hasCombinedDiff, HunkFile, parseCombinedParts, parseHunks, PatchMetadata, splitPatchMessages } from './patchText';
import { findRepositories, hasCommit, isRevision, parentOf, PatchTarget, resolvePatch, topLevel } from './repositories';
import {
    preserveReviewed,
    primarySection,
    Review,
    ReviewData,
    ReviewNode,
    reviewFileKey,
    reviewReference,
    ReviewSection,
    ReviewSource,
    ReviewTree,
    reviewTitle,
} from './reviews';
import { assembleSeries } from './seriesInput';

export type OpenMode = 'auto' | 'choose' | 'partial';

export interface ShownPatch {
    readonly id: string;
    readonly title: string;
    readonly mode: ReviewData['mode'];
    readonly repo?: string;
    readonly base?: string;
    readonly baseTree?: string;
    readonly sourceChanged?: boolean;
    readonly sections: readonly {
        readonly key: string;
        readonly label: string;
        readonly files: number;
        readonly reviewed: number;
    }[];
    readonly resources: readonly (readonly [string, string | undefined, string | undefined])[];
}

interface PatchSource extends ReviewSource {
    readonly folder?: string;
    readonly bytes: Uint8Array;
}

interface GitApi {
    readonly git: { readonly path: string };
    readonly repositories: readonly { readonly rootUri: vscode.Uri }[];
}

interface GitExtension {
    readonly enabled: boolean;
    getAPI(version: 1): GitApi;
}

interface SeriesRecipe {
    readonly name: string;
    readonly members: readonly vscode.Uri[];
}

/** A persisted review the user can reopen: identity, chosen target, and checkmarks. */
interface RecentPatch {
    readonly uri: string;
    readonly name: string;
    readonly digest: string;
    readonly mode: ReviewData['mode'];
    readonly repo?: string;
    readonly base?: string;
    readonly members?: readonly string[];
    readonly commit?: string;
    readonly reviewed: readonly string[];
    readonly when: number;
}

const RECENT_KEY = 'recentPatches';
const RECENT_LIMIT = 25;
const COMPARE_SCHEME = 'view-patch-compare';
const COMMIT_SCHEME = 'view-patch-commit';

const CHOOSE = 'Choose Repository and Base...';
const HUNKS_ONLY = 'View Hunks Only';
const OUTPUT = 'Show Output';
const MIB = 1024 * 1024;

export class ReviewController implements vscode.Disposable {
    readonly documents = new PatchDocuments();
    private readonly reviews = new Map<string, Review>();
    readonly tree = new ReviewTree(this.reviews);
    private readonly view: vscode.TreeView<ReviewNode>;
    private readonly titles = new Map<string, Set<string>>();
    private readonly pending = new Map<string, Promise<ShownPatch | undefined>>();
    private readonly aborters = new Set<AbortController>();
    private readonly recipes = new Map<string, SeriesRecipe>();
    private readonly watchers = new Map<string, vscode.Disposable[]>();
    private stateWrites: Promise<void> = Promise.resolve();
    private readonly subscriptions: vscode.Disposable[] = [];
    private nextId = 1;
    private syncTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    constructor(private readonly log: vscode.LogOutputChannel, private readonly state: vscode.Memento) {
        this.view = vscode.window.createTreeView('viewPatch.reviews', {
            treeDataProvider: this.tree,
            dragAndDropController: {
                dropMimeTypes: ['text/uri-list'],
                dragMimeTypes: [],
                handleDrop: async (_target, data) => {
                    const text = await data.get('text/uri-list')?.asString();
                    const dropped = (text ?? '').split(/\r?\n/)
                        .filter(line => line && !line.startsWith('#'))
                        .flatMap(line => {
                            try {
                                return [vscode.Uri.parse(line, true)];
                            } catch {
                                return [];
                            }
                        })
                        .filter(uri => /\.(patch|diff)$/i.test(uri.path));
                    if (dropped.length) {
                        await this.open(undefined, dropped);
                    }
                },
            },
        });
        this.subscriptions.push(
            this.view,
            this.tree,
            this.documents,
            vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleSync()),
            vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleSync()),
            vscode.workspace.onDidSaveTextDocument(document => this.sourceSaved(document)),
        );
    }

    async open(uri?: unknown, selected?: unknown, mode: OpenMode = 'auto'): Promise<ShownPatch[]> {
        const shown: ShownPatch[] = [];
        let sources: readonly vscode.Uri[] | undefined;
        try {
            sources = await pickSources(uri, selected);
        } catch (error) {
            this.report(error);
            return shown;
        }
        for (const source of sources ?? []) {
            const result = await this.run(source, mode);
            if (result) {
                shown.push(result);
            }
        }
        return shown;
    }

    async refresh(reference?: unknown): Promise<ShownPatch | undefined> {
        const review = this.find(reference);
        if (review.source.uri.scheme === COMPARE_SCHEME) {
            throw new Error('A version comparison has no single source patch to refresh.'
                + ' Run Compare with Another Patch again.');
        }
        if (review.source.uri.scheme === COMMIT_SCHEME) {
            if (!review.repo || !review.digest) {
                throw new Error('This commit review cannot refresh. Run Review a Commit again.');
            }
            return this.runCommitReview(review.repo, review.digest);
        }
        return this.run(review.source.uri, review.mode === 'partial' ? 'partial' : 'auto', true);
    }

    async openSeries(uri?: unknown, selected?: unknown): Promise<ShownPatch[]> {
        const supplied = Array.isArray(selected) ? selected.filter(isUri)
            : Array.isArray(uri) ? uri.filter(isUri) : isUri(uri) ? [uri] : undefined;
        const members = supplied && supplied.length > 1 ? supplied : await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Review as a Series',
            title: 'Select patches in application order; numbered patches are sorted automatically',
            filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
        });
        if (!members) {
            return [];
        }
        if (members.length < 2) {
            throw new Error('Select at least two patch files to open as a series.');
        }
        const unique = [...new Map(members.map(member => [member.toString(), member])).values()];
        if (unique.length !== members.length) {
            throw new Error('A patch file was selected more than once.');
        }
        const id = contentFingerprint(Buffer.from(unique.map(member => member.toString()).sort().join('\0')));
        const source = vscode.Uri.from({ scheme: 'view-patch-series', path: `/${id}` });
        this.recipes.set(source.toString(), {
            name: `Patch series (${unique.length} files)`,
            members: unique,
        });
        const shown = await this.run(source, 'auto');
        return shown ? [shown] : [];
    }

    async changeBase(reference?: unknown): Promise<ShownPatch | undefined> {
        const review = this.find(reference);
        if (review.source.uri.scheme === COMPARE_SCHEME) {
            throw new Error('A version comparison is tied to the base it was built on.'
                + ' Run Compare with Another Patch from a review on the wanted base.');
        }
        if (review.source.uri.scheme === COMMIT_SCHEME) {
            throw new Error('A commit review is pinned to its commit. Run Review a Commit for another revision.');
        }
        return this.run(review.source.uri, 'choose', true);
    }

    async showReview(reference?: unknown): Promise<ShownPatch> {
        const review = this.find(reference);
        const section = reviewReference(reference)?.sectionKey ?? review.section;
        await this.display(review, section);
        return this.describe(review);
    }

    async openFile(reference: unknown): Promise<void> {
        const ref = reviewReference(reference);
        const review = this.find(ref);
        if (!ref?.sectionKey || ref.fileIndex === undefined) {
            throw new Error('Select a file from Patch Reviews first.');
        }
        const [label, before, after] = this.documents.fileResources(
            review.id, ref.sectionKey, ref.fileIndex, review.repo,
        );
        const title = `${review.title}: ${path.posix.basename(label.path)}`;
        this.rememberTitle(review.id, title);
        review.opening = true;
        try {
            await vscode.commands.executeCommand(
                'vscode.diff',
                before ?? this.documents.emptyUri(review.id, label.path),
                after ?? this.documents.emptyUri(review.id, label.path),
                title,
                { preview: false },
            );
            await waitForTab(() => allTabs().some(tab => isSingleFileTab(tab)
                && tabUris(tab).some(uri => snapshotId(uri) === review.id)));
            review.seen = true;
            review.lastOpened = ref.fileIndex;
            if (vscode.workspace.getConfiguration('viewPatch').get<boolean>('markReviewedOnOpen', false)) {
                const section = review.sections.find(item => item.key === ref.sectionKey);
                const file = section?.files[ref.fileIndex];
                if (section && file) {
                    review.reviewed.add(reviewFileKey(section.key, file));
                    void this.rememberReview(review);
                    this.refreshTree();
                }
            }
        } finally {
            review.opening = false;
        }
    }

    async toggleReviewed(reference: unknown): Promise<void> {
        const ref = reviewReference(reference);
        const review = this.find(ref);
        const section = review.sections.find(item => item.key === ref?.sectionKey);
        const file = ref?.fileIndex === undefined ? undefined : section?.files[ref.fileIndex];
        if (!section || !file) {
            throw new Error('Select a file from Patch Reviews first.');
        }
        const key = reviewFileKey(section.key, file);
        if (review.reviewed.has(key)) {
            review.reviewed.delete(key);
        } else {
            review.reviewed.add(key);
        }
        await this.rememberReview(review);
        this.refreshTree();
    }

    async markAllReviewed(reference?: unknown): Promise<void> {
        const review = this.find(reference);
        for (const section of review.sections) {
            for (const file of section.files) {
                review.reviewed.add(reviewFileKey(section.key, file));
            }
        }
        await this.rememberReview(review);
        this.refreshTree();
    }

    async clearReviewed(reference?: unknown): Promise<void> {
        const review = this.find(reference);
        review.reviewed.clear();
        await this.rememberReview(review);
        this.refreshTree();
    }

    async exportSummary(reference?: unknown): Promise<string> {
        const review = this.find(reference);
        const lines: string[] = [`# ${review.title}`, ''];
        lines.push(`- Source: ${review.source.uri.scheme === 'file'
            ? review.source.uri.fsPath : review.source.uri.toString()}`);
        lines.push(`- Mode: ${review.mode === 'complete' ? 'complete files' : 'hunks only (partial context)'}`);
        if (review.repo) {
            lines.push(`- Repository: ${review.repo}`);
        }
        if (review.base) {
            lines.push(`- Base: ${review.base}`);
        }
        if (review.baseTree) {
            lines.push(`- Snapshot tree: ${review.baseTree}`);
        }
        if (review.metadata?.subject) {
            lines.push(`- Subject: ${review.metadata.subject}`);
        }
        if (review.metadata?.author) {
            lines.push(`- Author: ${review.metadata.author}`);
        }
        if (review.sourceChanged) {
            lines.push('- Note: the source patch changed after this snapshot was taken.');
        }
        const stats = await this.summaryStats(review);
        for (const section of review.sections) {
            const reviewed = section.files.filter(
                file => review.reviewed.has(reviewFileKey(section.key, file))).length;
            lines.push('', `## ${section.label} (${section.files.length} files, ${reviewed} reviewed)`, '');
            for (const [index, file] of section.files.entries()) {
                const checked = review.reviewed.has(reviewFileKey(section.key, file));
                const name = file.oldPath === file.newPath ? file.newPath : `${file.oldPath} -> ${file.newPath}`;
                const counts = stats?.get(`${section.key}\0${index}`);
                const suffix = counts ? ` (+${counts.insertions}/-${counts.deletions})` : '';
                lines.push(`- [${checked ? 'x' : ' '}] \`${name}\` ${fileStatusLabel(file)}${suffix}`);
            }
        }
        const text = `${lines.join('\n')}\n`;
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage('View Patch: review summary copied as Markdown.', 4000);
        return text;
    }

    async openRecent(): Promise<ShownPatch[]> {
        const entries = this.recent();
        if (!entries.length) {
            void vscode.window.showInformationMessage('View Patch: no recent patches to reopen yet.');
            return [];
        }
        const picked = await vscode.window.showQuickPick(entries.map(entry => ({
            label: entry.name,
            description: entry.mode === 'partial' ? 'hunks only'
                : entry.repo ? path.basename(entry.repo) : '',
            detail: entry.members ? `${entry.members.length} patch files`
                : entry.uri.startsWith('file:') ? vscode.Uri.parse(entry.uri).fsPath : entry.uri,
            entry,
        })), { title: 'View Patch: reopen a recent review' });
        if (!picked) {
            return [];
        }
        if (picked.entry.members) {
            return this.openSeries(undefined, picked.entry.members.map(member => vscode.Uri.parse(member)));
        }
        if (picked.entry.commit && picked.entry.repo) {
            const shown = await this.runCommitReview(picked.entry.repo, picked.entry.commit);
            return shown ? [shown] : [];
        }
        const shown = await this.run(
            vscode.Uri.parse(picked.entry.uri),
            picked.entry.mode === 'partial' ? 'partial' : 'auto',
        );
        return shown ? [shown] : [];
    }

    async openSample(): Promise<ShownPatch[]> {
        const document = await vscode.workspace.openTextDocument({ language: 'diff', content: SAMPLE_PATCH });
        const shown = await this.run(document.uri, 'partial');
        return shown ? [shown] : [];
    }

    async openFromClipboard(): Promise<ShownPatch[]> {
        const text = await vscode.env.clipboard.readText();
        if (!text.trim() || !looksLikePatch(text)) {
            void vscode.window.showWarningMessage(
                'View Patch: the clipboard does not contain a recognizable patch.'
                + ' Expected Git or unified-diff file headers.');
            return [];
        }
        const document = await vscode.workspace.openTextDocument({ language: 'diff', content: text });
        const shown = await this.run(document.uri, 'auto');
        return shown ? [shown] : [];
    }

    /** Reviews any commit from history: no patch file, per-parent sections for merges. */
    async reviewCommit(repoArg?: unknown, revisionArg?: unknown): Promise<ShownPatch | undefined> {
        const api = await this.gitApi();
        const git = new Git(gitExecutable(api));
        const probe = new AbortController();
        try {
            const options = configuredOptions(probe.signal);
            let repo: string | undefined;
            if (isUri(repoArg) || typeof repoArg === 'string') {
                const folder = isUri(repoArg) ? repoArg.fsPath : repoArg;
                repo = await topLevel(git, folder, options);
                if (!repo) {
                    throw new Error('That folder is not in a Git repository.');
                }
            } else {
                const candidates = await findRepositories(git, knownFolders(api), options);
                const picked = await vscode.window.showQuickPick([
                    ...candidates.map(folder => ({ label: path.basename(folder), description: folder, folder })),
                    { label: '$(folder-opened) Browse...', description: '', folder: '' },
                ], { title: 'View Patch: repository holding the commit' });
                if (!picked) {
                    return undefined;
                }
                repo = picked.folder;
                if (!repo) {
                    const folders = await vscode.window.showOpenDialog({
                        canSelectFiles: false, canSelectFolders: true, openLabel: 'Use This Repository',
                    });
                    if (!folders) {
                        return undefined;
                    }
                    repo = await topLevel(git, folders[0].fsPath, options);
                    if (!repo) {
                        throw new Error('That folder is not in a Git repository.');
                    }
                }
            }
            let revision: string;
            if (typeof revisionArg === 'string' && revisionArg.trim()) {
                revision = revisionArg.trim();
            } else {
                const typed = (await vscode.window.showInputBox({
                    title: `View Patch: commit to review in ${path.basename(repo)}`,
                    prompt: 'A commit hash, branch, tag, or revision expression.',
                    value: 'HEAD',
                    validateInput: async value => await isRevision(git, repo, value.trim(), options)
                        ? undefined : `"${value.trim()}" is not a revision in this repository.`,
                }))?.trim();
                if (!typed) {
                    return undefined;
                }
                revision = typed;
            }
            return await this.runCommitReview(repo, revision);
        } catch (error) {
            this.report(error, 'Review a Commit');
            return undefined;
        } finally {
            probe.abort();
        }
    }

    private async runCommitReview(repo: string, revision: string): Promise<ShownPatch | undefined> {
        const name = `${path.basename(repo)} @ ${revision.slice(0, 40)}`;
        const aborter = new AbortController();
        this.aborters.add(aborter);
        try {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `View Patch: ${name}`,
                cancellable: true,
            }, async (_progress, token) => {
                const listener = token.onCancellationRequested(() => aborter.abort());
                try {
                    const options = configuredOptions(aborter.signal);
                    const api = await this.gitApi();
                    const git = new Git(gitExecutable(api));
                    const result = await commitChanges(git, repo, revision, options);
                    throwIfAborted(options.signal);
                    const sections: ReviewSection[] = result.perParent.map((part, index) => ({
                        key: index === 0 ? 'combined' : `parent${index + 1}`,
                        label: part.parent
                            ? `Versus parent ${index + 1} (${part.parent.slice(0, 12)})`
                            : 'Versus the empty tree (root commit)',
                        files: snapshotFiles(part),
                    }));
                    const short = result.commit.slice(0, 12);
                    const data: ReviewData = {
                        source: {
                            uri: vscode.Uri.from({
                                scheme: COMMIT_SCHEME,
                                path: `/${contentFingerprint(Buffer.from(repo))}/${result.commit}`,
                            }),
                            name: `commit ${short}`,
                        },
                        digest: result.commit,
                        mode: 'complete',
                        sections,
                        repo,
                        base: result.parents[0],
                        metadata: {
                            commit: result.commit,
                            subject: result.subject ?? `Commit ${short}`,
                            author: result.author,
                            date: result.date,
                        },
                    };
                    const previous = [...this.reviews.values()].find(
                        item => item.source.uri.toString() === data.source.uri.toString());
                    return await this.install(data, previous);
                } finally {
                    listener.dispose();
                }
            });
        } catch (error) {
            this.report(error, name);
            return undefined;
        } finally {
            this.aborters.delete(aborter);
        }
    }

    nextUnreviewed(reference?: unknown): Promise<void> {
        return this.stepUnreviewed(reference, 1);
    }

    previousUnreviewed(reference?: unknown): Promise<void> {
        return this.stepUnreviewed(reference, -1);
    }

    private async stepUnreviewed(reference: unknown, direction: 1 | -1): Promise<void> {
        const review = this.find(reference);
        const section = review.sections.find(item => item.key === review.section) ?? review.sections[0];
        if (!section || section.files.length === 0) {
            throw new Error('This review has no files to step through.');
        }
        const count = section.files.length;
        const start = review.lastOpened ?? (direction === 1 ? -1 : count);
        for (let step = 1; step <= count; step++) {
            const index = ((start + direction * step) % count + count) % count;
            const file = section.files[index];
            if (!review.reviewed.has(reviewFileKey(section.key, file))) {
                await this.openFile({ reviewId: review.id, sectionKey: section.key, fileIndex: index });
                return;
            }
        }
        void vscode.window.showInformationMessage('View Patch: every file in this section is marked reviewed.');
    }

    /** Copies one file's change as a valid unified diff. Complete reviews only: partial views have no full sides. */
    async copyFileDiff(reference: unknown): Promise<string> {
        const ref = reviewReference(reference);
        const review = this.find(ref);
        const section = review.sections.find(item => item.key === ref?.sectionKey);
        const file = ref?.fileIndex === undefined ? undefined : section?.files[ref.fileIndex];
        if (!section || !file) {
            throw new Error('Select a file from Patch Reviews first.');
        }
        if (review.mode !== 'complete') {
            throw new Error('Copying a single file diff needs a complete-file review;'
                + ' a hunk-only view already is the patch content.');
        }
        if (file.kind === 'metadata') {
            throw new Error(`This entry is ${file.note ?? 'metadata only'}; there is no content diff to copy.`);
        }
        const api = await this.gitApi();
        const git = new Git(gitExecutable(api));
        const aborter = new AbortController();
        try {
            const text = await unifiedFileDiff(git, {
                oldPath: file.oldPath, newPath: file.newPath, before: file.before, after: file.after,
            }, configuredOptions(aborter.signal));
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage(`View Patch: diff for ${file.newPath} copied.`, 4000);
            return text;
        } finally {
            aborter.abort();
        }
    }

    async copyDiagnostics(): Promise<string> {
        const api = await this.gitApi();
        const executable = gitExecutable(api);
        let gitVersion: string;
        try {
            const output = await new Git(executable).run(
                ['--version'], { cwd: os.homedir(), timeoutMs: 10_000, maxOutputBytes: 4096 });
            gitVersion = output.toString('utf8').trim();
        } catch (error) {
            gitVersion = `unavailable: ${firstLines(errorMessage(error))}`;
        }
        const manifest = vscode.extensions.getExtension('waddahmoghram.view-patch')?.packageJSON as
            { version?: string } | undefined;
        const configured = vscode.workspace.getConfiguration('viewPatch').get<unknown[]>('repositories', []);
        // The web extension host has no Node process object, and reading one there throws.
        const node = typeof process === 'undefined' ? undefined : process.versions?.node;
        const platform = node === undefined
            ? 'browser (no Node.js)'
            : `${process.platform} ${process.arch}; Node ${node}`;
        const text = [
            `View Patch ${manifest?.version ?? '(unknown version)'}`,
            `Editor: ${vscode.env.appName} ${vscode.version} (${vscode.env.appHost})`,
            `Remote: ${vscode.env.remoteName ?? '(none)'}`,
            `Platform: ${platform}`,
            `Workspace folders: ${vscode.workspace.workspaceFolders?.length ?? 0}; trusted: ${vscode.workspace.isTrusted}`,
            `Git executable: ${executable}`,
            `Git version: ${gitVersion}`,
            `Git extension repositories: ${api ? api.repositories.length : '(unavailable)'}`,
            `viewPatch.repositories entries: ${Array.isArray(configured) ? configured.length : '(invalid)'}`,
            `Open reviews: ${this.reviews.size}`,
        ].join('\n') + '\n';
        await vscode.env.clipboard.writeText(text);
        this.log.info(`Diagnostics copied:\n${text}`);
        vscode.window.setStatusBarMessage('View Patch: diagnostics copied to the clipboard.', 4000);
        return text;
    }

    /** Applies this review's patch and another version to the same base, then shows the result difference. */
    async compareWith(reference?: unknown, other?: unknown): Promise<ShownPatch | undefined> {
        const review = this.find(reference);
        if (review.mode !== 'complete' || !review.repo || !review.base) {
            throw new Error('Version comparison needs a complete-file review with a repository and base.'
                + ' Hunk-only views have no applied result to compare.');
        }
        const repo = review.repo;
        const base = review.base;
        const otherUri = isUri(other) ? other : (await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Compare',
            title: `View Patch: compare ${review.source.name} with another patch version`,
            defaultUri: review.source.uri.scheme === 'file'
                ? vscode.Uri.file(path.dirname(review.source.uri.fsPath)) : undefined,
            filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
        }))?.[0];
        if (!otherUri) {
            return undefined;
        }
        const name = `${review.source.name} vs ${path.posix.basename(otherUri.path)}`;
        const aborter = new AbortController();
        this.aborters.add(aborter);
        try {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `View Patch: ${name}`,
                cancellable: true,
            }, async (_progress, token) => {
                const listener = token.onCancellationRequested(() => aborter.abort());
                try {
                    const options = configuredOptions(aborter.signal);
                    const current = await this.readSource(review.source.uri, options);
                    const second = await this.readSource(otherUri, options);
                    const api = await this.gitApi();
                    const git = new Git(gitExecutable(api));
                    const comparison = await compareApplied(
                        git, repo, base, current.bytes, second.bytes, options);
                    throwIfAborted(options.signal);
                    if (!comparison.changes.length && !comparison.skipped.length) {
                        void vscode.window.showInformationMessage(
                            `View Patch: both patch versions produce the same result on ${base}.`);
                        return undefined;
                    }
                    const identity = contentFingerprint(Buffer.from(
                        `${comparison.first.resultTree}\0${comparison.second.resultTree}\0${repo}`));
                    const data: ReviewData = {
                        source: {
                            uri: vscode.Uri.from({ scheme: COMPARE_SCHEME, path: `/${identity}` }),
                            name,
                        },
                        digest: contentFingerprint(Buffer.concat([
                            Buffer.from(current.bytes), Buffer.from(second.bytes)])),
                        mode: 'complete',
                        sections: [{
                            key: 'combined',
                            label: 'Differences Between Versions',
                            files: snapshotFiles(comparison),
                        }],
                        repo,
                        base,
                        baseTree: comparison.baseTree,
                        metadata: {
                            subject: `Result difference on ${base}:`
                                + ` ${review.source.name} -> ${path.posix.basename(otherUri.path)}`,
                        },
                    };
                    const previous = [...this.reviews.values()].find(
                        item => item.source.uri.toString() === data.source.uri.toString());
                    return await this.install(data, previous);
                } finally {
                    listener.dispose();
                }
            });
        } catch (error) {
            this.report(error, name);
            return undefined;
        } finally {
            this.aborters.delete(aborter);
        }
    }

    async filter(value?: unknown): Promise<void> {
        const text = typeof value === 'string' ? value : await vscode.window.showInputBox({
            title: 'Filter Patch Reviews',
            prompt: 'Show paths containing this text. Leave empty to show all files.',
            value: this.tree.filter,
        });
        if (text === undefined) {
            return;
        }
        this.tree.filter = text.trim();
        this.view.description = this.tree.filter ? `filter: ${this.tree.filter}` : undefined;
        await vscode.commands.executeCommand('setContext', 'viewPatch.filtered', this.tree.filter !== '');
        this.refreshTree();
    }

    async close(reference?: unknown): Promise<void> {
        const review = this.find(reference);
        const tabs = allTabs().filter(tab => this.ownsTab(review, tab));
        if (tabs.length && !(await vscode.window.tabGroups.close(tabs, true))) {
            throw new Error('The review could not close. Its content has been kept.');
        }
        this.remove(review.id);
    }

    async reveal(): Promise<void> {        await vscode.commands.executeCommand('viewPatch.reviews.focus');
    }

    list(): ShownPatch[] {
        return [...this.reviews.values()].map(review => this.describe(review));
    }

    report(error: unknown, name?: string): void {
        if (error instanceof OperationCancelledError) {
            this.log.info(`${name ?? 'Patch'}: cancelled.`);
            vscode.window.setStatusBarMessage('View Patch: cancelled.', 4000);
            return;
        }
        const text = errorMessage(error);
        this.log.error(name ? `${name}: ${text}` : text);
        void vscode.window.showErrorMessage(
            `View Patch: ${name ? `${name}: ` : ''}${firstLines(text)}`, OUTPUT,
        ).then(answer => {
            if (answer === OUTPUT) {
                this.log.show(true);
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        clearTimeout(this.syncTimer);
        for (const aborter of this.aborters) {
            aborter.abort();
        }
        for (const watchers of this.watchers.values()) {
            watchers.forEach(watcher => watcher.dispose());
        }
        this.watchers.clear();
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.reviews.clear();
        this.titles.clear();
        this.recipes.clear();
    }

    private async run(uri: vscode.Uri, mode: OpenMode, force = false): Promise<ShownPatch | undefined> {
        const key = uri.toString();
        const active = this.pending.get(key);
        if (active) {
            return active;
        }
        const task = this.loadWithProgress(uri, mode, force);
        this.pending.set(key, task);
        try {
            return await task;
        } finally {
            this.pending.delete(key);
        }
    }

    private async loadWithProgress(uri: vscode.Uri, mode: OpenMode, force: boolean): Promise<ShownPatch | undefined> {
        const name = this.recipes.get(uri.toString())?.name ?? path.posix.basename(uri.path);
        const aborter = new AbortController();
        this.aborters.add(aborter);
        try {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `View Patch: ${name}`,
                cancellable: true,
            }, async (_progress, token) => {
                const listener = token.onCancellationRequested(() => aborter.abort());
                try {
                    const options = configuredOptions(aborter.signal);
                    const source = await this.readSource(uri, options);
                    throwIfAborted(options.signal);
                    const previous = [...this.reviews.values()].find(
                        item => item.source.uri.toString() === uri.toString(),
                    );
                    const digest = contentFingerprint(source.bytes);
                    if (!force && mode === 'auto' && previous?.digest === digest) {
                        await this.display(previous, previous.section);
                        return this.describe(previous);
                    }
                    if (mode !== 'partial' && !vscode.workspace.isTrusted) {
                        this.offerTrust(source);
                        return undefined;
                    }
                    const data = mode === 'partial'
                        ? partialData(source, digest, options)
                        : await this.completeData(source, digest, mode, options, force ? previous : undefined);
                    throwIfAborted(options.signal);
                    return data && await this.install(data, previous);
                } finally {
                    listener.dispose();
                }
            });
        } catch (error) {
            this.report(error, name);
            return undefined;
        } finally {
            this.aborters.delete(aborter);
        }
    }

    private async completeData(
        source: PatchSource,
        digest: string,
        mode: OpenMode,
        options: OperationOptions,
        previous?: Review,
    ): Promise<ReviewData | undefined> {
        if (!looksLikePatch(Buffer.from(source.bytes).toString('utf8'))) {
            throw new Error('This is not a supported patch. Expected Git or unified-diff file headers.');
        }
        const api = await this.gitApi();
        const git = new Git(gitExecutable(api));
        if (previous?.repo && previous.base && mode !== 'choose') {
            const applied = await applyPatch(git, previous.repo, previous.base, source.bytes, options);
            return completeReview(source, digest, { repo: previous.repo, base: previous.base, applied });
        }
        const candidates = await findRepositories(git, candidateFolders(source, api), options);
        const commit = patchCommit(Buffer.from(source.bytes).toString('utf8'));
        const search = candidates.join(', ') || '(none)';
        this.log.info(`${source.name}: commit ${commit ?? '(none)'}; repositories: ${search}`);
        if (hasCombinedDiff(source.bytes)) {
            return this.mergeData(source, digest, git, candidates, commit, options);
        }
        if (mode === 'auto') {
            const remembered = this.recent().find(entry =>
                entry.uri === source.uri.toString() && entry.digest === digest
                && entry.repo !== undefined && entry.base !== undefined);
            if (remembered?.repo && remembered.base) {
                try {
                    const applied = await applyPatch(git, remembered.repo, remembered.base, source.bytes, options);
                    this.log.info(`${source.name}: using the remembered repository ${remembered.repo}`
                        + ` at ${remembered.base}.`);
                    return completeReview(source, digest, {
                        repo: remembered.repo, base: remembered.base, applied,
                    });
                } catch (error) {
                    if (error instanceof OperationCancelledError) {
                        throw error;
                    }
                    this.log.info(`${source.name}: the remembered repository no longer applies:`
                        + ` ${firstLines(errorMessage(error))}`);
                }
            }
        }
        if (mode === 'choose') {
            const target = await chooseTarget(git, candidates, source, options, commit);
            return target && completeReview(source, digest, target);
        }
        const resolution = await resolvePatch(git, candidates, source.bytes, commit, options);
        for (const failure of resolution.failures) {
            this.log.info(`${source.name} does not apply on ${failure.base} in ${failure.repo}: ${failure.reason}`);
        }
        if (!resolution.targets.length) {
            const appliedAt = resolution.alreadyApplied ?? [];
            if (appliedAt.length) {
                const where = appliedAt.map(entry => `${entry.repo} at ${entry.revision}`).join('; ');
                this.offerFallback(source,
                    `This patch is already applied in ${where}. There is nothing left to apply;`
                    + ' a hunk-only view still shows the stated changes.');
                return undefined;
            }
            const reason = resolution.failures[0]?.reason;
            const detail = reason ? ` ${firstLines(reason)}` : '';
            this.offerFallback(source, candidates.length
                ? `The patch does not apply in the available repositories.${detail}`
                : 'No Git repository was found. Open its repository or choose a hunk-only view.');
            return undefined;
        }
        const target = resolution.targets.length === 1
            ? resolution.targets[0]
            : await vscode.window.showQuickPick(resolution.targets.map(item => ({
                label: path.basename(item.repo), description: item.repo, target: item,
            })), { title: 'The patch applies in more than one repository. Which one?' }).then(item => item?.target);
        return target && completeReview(source, digest, target);
    }

    /** Builds a merge-commit review from real per-parent history instead of applying the combined text. */
    private async mergeData(
        source: PatchSource,
        digest: string,
        git: Git,
        candidates: readonly string[],
        commit: string | undefined,
        options: OperationOptions,
    ): Promise<ReviewData | undefined> {
        if (!commit) {
            this.offerFallback(source, 'This combined merge diff does not name its commit, so the real'
                + ' per-parent changes cannot be reconstructed. Hunk-only per-parent views are available.');
            return undefined;
        }
        let repo: string | undefined;
        for (const candidate of candidates) {
            throwIfAborted(options.signal);
            if (await hasCommit(git, candidate, commit, options)) {
                repo = candidate;
                break;
            }
        }
        if (!repo) {
            this.offerFallback(source, `Merge commit ${commit.slice(0, 12)} was not found in the available`
                + ' repositories. Hunk-only per-parent views are available.');
            return undefined;
        }
        const merged = await mergeChanges(git, repo, commit, options);
        throwIfAborted(options.signal);
        if (merged.parents.length < 2) {
            this.offerFallback(source, 'The commit named by this combined diff is not a merge commit in'
                + ' the found repository. Hunk-only views are available.');
            return undefined;
        }
        const metadata = splitPatchMessages(source.bytes)[0]?.metadata;
        const sections: ReviewSection[] = merged.perParent.map((part, index) => ({
            key: index === 0 ? 'combined' : `parent${index + 1}`,
            label: `Versus parent ${index + 1} (${merged.parents[index].slice(0, 12)})`,
            files: snapshotFiles(part),
        }));
        this.log.info(`${source.name}: merge ${commit.slice(0, 12)} in ${repo};`
            + ` ${merged.parents.length} parents from history.`);
        return {
            source, digest, mode: 'complete', sections, repo,
            base: merged.parents[0],
            metadata: metadata?.subject ? metadata : { ...metadata, subject: `Merge ${commit.slice(0, 12)}` },
        };
    }

    private async install(data: ReviewData, previous?: Review): Promise<ShownPatch> {
        if (this.disposed) {
            throw new OperationCancelledError();
        }
        const id = previous?.id ?? `r${this.nextId++}`;
        const selected = data.sections.find(item => item.key === previous?.section) ?? primarySection(data);
        const section = selected?.files.length
            ? selected : data.sections.find(item => item.files.length > 0) ?? selected;
        if (!section) {
            throw new Error('This patch contains no reviewable file changes.');
        }
        const review: Review = {
            ...data,
            id,
            title: reviewTitle(data.source.name, Number(id.slice(1)), data.mode),
            reviewed: previous ? preserveReviewed(previous, data) : this.storedReviewed(data),
            section: section.key,
            opening: true,
            seen: previous?.seen ?? false,
        };
        this.documents.setLimit(configuredCacheLimit());
        this.documents.replace(id, data.sections);
        this.reviews.set(id, review);
        try {
            await this.display(review, section.key);
        } catch (error) {
            if (previous) {
                this.reviews.set(id, previous);
                this.documents.replace(id, previous.sections);
            } else {
                this.remove(id);
            }
            throw error;
        } finally {
            review.opening = false;
        }
        this.log.info(`${data.source.name}: ${data.mode} review ${id}; base ${data.base ?? '(hunks only)'}.`);
        this.watchSource(review);
        void this.rememberReview(review);
        this.refreshTree();
        await vscode.commands.executeCommand('setContext', 'viewPatch.hasReviews', true);
        return this.describe(review);
    }

    private async display(review: Review, sectionKey: string): Promise<void> {
        const section = review.sections.find(item => item.key === sectionKey);
        if (!section) {
            throw new Error('That patch is no longer in this series. Refresh the review.');
        }
        if (section.files.length === 0) {
            void vscode.window.showInformationMessage('View Patch: this section has no net file changes.');
            return;
        }
        const title = sectionTitle(review, section);
        review.opening = true;
        try {
            const old = allTabs().filter(tab => this.ownsTitle(review.id, tab.label) && !isSingleFileTab(tab));
            if (old.length && !(await vscode.window.tabGroups.close(old, true))) {
                throw new Error('The existing patch tab could not be refreshed. Its content has been kept.');
            }
            this.rememberTitle(review.id, title);
            await vscode.commands.executeCommand(
                'vscode.changes', title, this.documents.resources(review.id, section.key, review.repo),
            );
            await waitForTab(() => allTabs().some(tab => matchesTitle(title, tab.label)));
            // Changes views otherwise behave as preview tabs and replace earlier reviews.
            await vscode.commands.executeCommand('workbench.action.keepEditor');
            review.section = section.key;
            review.seen = true;
            this.refreshTree();
        } finally {
            review.opening = false;
        }
    }

    private describe(review: Review): ShownPatch {
        return {
            id: review.id,
            title: review.title,
            mode: review.mode,
            repo: review.repo,
            base: review.base,
            baseTree: review.baseTree,
            sourceChanged: review.sourceChanged,
            sections: review.sections.map(section => ({
                key: section.key,
                label: section.label,
                files: section.files.length,
                reviewed: section.files.filter(file => review.reviewed.has(reviewFileKey(section.key, file))).length,
            })),
            resources: this.documents.resources(review.id, review.section, review.repo).map(
                ([label, before, after]) => [label.toString(), before?.toString(), after?.toString()] as const,
            ),
        };
    }

    private find(reference?: unknown): Review {
        const ref = reviewReference(reference);
        if (reference !== undefined && !ref) {
            throw new Error('Invalid review reference. Select a review from Patch Reviews.');
        }
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        const selected = this.view.selection[0]?.reviewId;
        const review = ref ? this.reviews.get(ref.reviewId) : [...this.reviews.values()].find(
            item => active && this.ownsTab(item, active),
        ) ?? (selected ? this.reviews.get(selected) : undefined) ?? [...this.reviews.values()].at(-1);
        if (!review) {
            throw new Error('There is no open patch review. Open a patch first.');
        }
        return review;
    }

    private sourceSaved(document: vscode.TextDocument): void {
        this.markChanged(
            document.uri.toString(),
            contentFingerprint(Buffer.from(document.getText(), 'utf8')),
        );
    }

    private markChanged(uri: string, digest: string): void {
        const affected = [...this.reviews.values()].filter(review => {
            if (review.sourceChanged) {
                return false;
            }
            const contains = review.source.uri.toString() === uri
                || review.source.members?.some(member => member.toString() === uri);
            const earlier = review.source.memberDigests?.get(uri) ?? review.digest;
            return contains && digest !== earlier;
        });
        if (!affected.length) {
            return;
        }
        affected.forEach(review => review.sourceChanged = true);
        this.refreshTree();
        const name = affected.length === 1 ? affected[0].source.name : `${affected.length} open reviews`;
        void vscode.window.showInformationMessage(
            `View Patch: source changes affect ${name}. Open reviews still show their earlier snapshots.`, 'Refresh',
        ).then(async answer => {
            if (answer === 'Refresh') {
                for (const review of affected) {
                    if (this.reviews.has(review.id)) {
                        await this.run(review.source.uri, review.mode === 'partial' ? 'partial' : 'auto', true);
                    }
                }
            }
        });
    }

    private ownsTab(review: Review, tab: vscode.Tab): boolean {
        if (this.ownsTitle(review.id, tab.label)) {
            return true;
        }
        return tabUris(tab).some(uri => snapshotId(uri) === review.id);
    }

    private ownsTitle(id: string, label: string): boolean {
        return [...this.titles.get(id) ?? []].some(title => matchesTitle(title, label));
    }

    private rememberTitle(id: string, title: string): void {
        const titles = this.titles.get(id) ?? new Set<string>();
        titles.add(title);
        this.titles.set(id, titles);
    }

    private scheduleSync(): void {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            if (this.disposed) {
                return;
            }
            const tabs = allTabs();
            for (const review of this.reviews.values()) {
                if (!review.opening && review.seen && !tabs.some(tab => this.ownsTab(review, tab))) {
                    this.log.debug(`${review.id}: releasing content after its last tab closed.`);
                    this.remove(review.id);
                }
            }
        }, 150);
    }

    private remove(id: string): void {
        const source = this.reviews.get(id)?.source.uri.toString();
        this.unwatch(id);
        this.documents.remove(id);
        this.reviews.delete(id);
        this.titles.delete(id);
        if (source) {
            this.recipes.delete(source);
        }
        this.refreshTree();
        void vscode.commands.executeCommand('setContext', 'viewPatch.hasReviews', this.reviews.size > 0);
    }

    private refreshTree(): void {
        let unreviewed = 0;
        for (const review of this.reviews.values()) {
            const section = review.sections.find(item => item.key === review.section) ?? review.sections[0];
            for (const file of section?.files ?? []) {
                if (!review.reviewed.has(reviewFileKey(section.key, file))) {
                    unreviewed += 1;
                }
            }
        }
        this.view.badge = unreviewed
            ? { value: unreviewed, tooltip: `${unreviewed} file(s) not yet marked reviewed` } : undefined;
        this.tree.refresh();
    }

    /** Watches file-backed sources so externally regenerated patches offer the same refresh as in-editor saves. */
    private watchSource(review: Review): void {
        this.unwatch(review.id);
        const targets = [review.source.uri, ...(review.source.members ?? [])]
            .filter(target => target.scheme === 'file');
        const watchers: vscode.Disposable[] = [];
        for (const target of targets) {
            const pattern = new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(target.fsPath)), path.basename(target.fsPath));
            const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);
            const changed = async (uri: vscode.Uri): Promise<void> => {
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    this.markChanged(uri.toString(), contentFingerprint(Buffer.from(bytes)));
                } catch {
                    // The file became unreadable; deletion is not a content change to prompt about.
                }
            };
            watcher.onDidChange(changed);
            watcher.onDidCreate(changed);
            watchers.push(watcher);
        }
        this.watchers.set(review.id, watchers);
    }

    private unwatch(id: string): void {
        this.watchers.get(id)?.forEach(watcher => watcher.dispose());
        this.watchers.delete(id);
    }

    private recent(): RecentPatch[] {
        const stored = this.state.get<unknown>(RECENT_KEY);
        return Array.isArray(stored) ? stored.filter(isRecentPatch) : [];
    }

    /** Serialized persistence: captures the review's state when its turn comes, so writes never reorder. */
    private rememberReview(review: Review): Promise<void> {
        if (review.source.uri.scheme === 'untitled' || review.source.uri.scheme === COMPARE_SCHEME) {
            return Promise.resolve();
        }
        const task = this.stateWrites.then(async () => {
            const entry: RecentPatch = {
                uri: review.source.uri.toString(),
                name: review.source.name,
                digest: review.digest,
                mode: review.mode,
                repo: review.repo,
                base: review.base,
                members: review.source.members?.map(member => member.toString()),
                commit: review.source.uri.scheme === COMMIT_SCHEME ? review.digest : undefined,
                reviewed: [...review.reviewed],
                when: Date.now(),
            };
            const rest = this.recent().filter(item => item.uri !== entry.uri);
            try {
                await this.state.update(RECENT_KEY, [entry, ...rest].slice(0, RECENT_LIMIT));
            } catch (error) {
                this.log.warn(`Could not save the recent-patch list: ${errorMessage(error)}`);
            }
        });
        this.stateWrites = task;
        return task;
    }

    /** Line counts per content file for complete reviews; absent on any failure rather than blocking the export. */
    private async summaryStats(review: Review): Promise<Map<string, { insertions: number; deletions: number }> | undefined> {
        if (review.mode !== 'complete') {
            return undefined;
        }
        const keys: string[] = [];
        const inputs: FileDiffInput[] = [];
        for (const section of review.sections) {
            for (const [index, file] of section.files.entries()) {
                if (file.kind !== 'metadata') {
                    keys.push(`${section.key}\0${index}`);
                    inputs.push({
                        oldPath: file.oldPath, newPath: file.newPath, before: file.before, after: file.after,
                    });
                }
            }
        }
        if (!inputs.length) {
            return undefined;
        }
        const aborter = new AbortController();
        try {
            const api = await this.gitApi();
            const git = new Git(gitExecutable(api));
            const stats = await fileDiffStats(git, inputs, configuredOptions(aborter.signal));
            const result = new Map<string, { insertions: number; deletions: number }>();
            stats.forEach((entry, index) => {
                if (entry) {
                    result.set(keys[index], entry);
                }
            });
            return result;
        } catch (error) {
            this.log.info(`Summary line counts unavailable: ${firstLines(errorMessage(error))}`);
            return undefined;
        } finally {
            aborter.abort();
        }
    }

    private storedReviewed(data: ReviewData): Set<string> {
        const stored = this.recent().find(entry =>
            entry.uri === data.source.uri.toString() && entry.digest === data.digest);
        if (!stored?.reviewed.length) {
            return new Set();
        }
        const valid = new Set<string>();
        for (const section of data.sections) {
            for (const file of section.files) {
                valid.add(reviewFileKey(section.key, file));
            }
        }
        return new Set(stored.reviewed.filter(key => valid.has(key)));
    }

    private offerTrust(source: PatchSource): void {
        const manage = 'Manage Workspace Trust';
        void vscode.window.showWarningMessage(
            'View Patch runs Git only in trusted workspaces. A hunk-only view does not run Git.',
            HUNKS_ONLY, manage,
        ).then(async answer => {
            try {
                if (answer === HUNKS_ONLY) {
                    await this.run(source.uri, 'partial');
                } else if (answer === manage) {
                    await vscode.commands.executeCommand('workbench.trust.manage');
                }
            } catch (error) {
                this.report(error, source.name);
            }
        });
    }

    private offerFallback(source: PatchSource, reason: string): void {
        this.log.warn(`${source.name}: ${reason}`);
        void vscode.window.showErrorMessage(`View Patch: ${reason}`, CHOOSE, HUNKS_ONLY, OUTPUT).then(async answer => {
            if (answer === CHOOSE || answer === HUNKS_ONLY) {
                await this.run(source.uri, answer === CHOOSE ? 'choose' : 'partial');
            } else if (answer === OUTPUT) {
                this.log.show(true);
            }
        });
    }

    private async gitApi(): Promise<GitApi | undefined> {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            return undefined;
        }
        try {
            const exports = extension.isActive ? extension.exports : await extension.activate();
            return exports.enabled ? exports.getAPI(1) : undefined;
        } catch (error) {
            this.log.warn(`The built-in Git extension is not available: ${errorMessage(error)}`);
            return undefined;
        }
    }

    private async readSource(uri: vscode.Uri, options: OperationOptions): Promise<PatchSource> {
        const recipe = this.recipes.get(uri.toString());
        if (!recipe) {
            return readSource(uri, options);
        }
        const sources: PatchSource[] = [];
        let total = 0;
        for (const member of recipe.members) {
            const source = await readSource(member, options);
            total += source.bytes.length;
            checkPatchSize(total, options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);
            sources.push(source);
        }
        return {
            uri, name: recipe.name, members: recipe.members, folder: sources[0]?.folder,
            bytes: assembleSeries(sources, options),
            memberDigests: new Map(sources.map(source => [source.uri.toString(), contentFingerprint(source.bytes)])),
        };
    }
}

function completeReview(source: PatchSource, digest: string, target: PatchTarget): ReviewData {
    const applied = target.applied;
    const parts = applied.parts ?? [];
    const sections: ReviewSection[] = [{
        key: 'combined',
        label: parts.length > 1 ? 'Combined Changes' : 'Changes',
        files: snapshotFiles(applied),
    }];
    if (parts.length > 1) {
        for (const [index, part] of parts.entries()) {
            sections.push({
                key: `part${index + 1}`,
                label: partLabel(part.metadata, index + 1, parts.length),
                metadata: part.metadata,
                files: snapshotFiles(part),
            });
        }
    }
    return {
        source, digest, mode: 'complete', sections, repo: target.repo, base: target.base,
        baseTree: applied.baseTree, metadata: applied.metadata ?? parts[0]?.metadata,
    };
}

function partialData(source: PatchSource, digest: string, options: OperationOptions): ReviewData {
    if (hasCombinedDiff(source.bytes)) {
        const combinedParts = parseCombinedParts(source.bytes, options);
        const sections: ReviewSection[] = [];
        for (const [index, part] of combinedParts.entries()) {
            const prefix = combinedParts.length === 1 ? '' : `[${index + 1}/${combinedParts.length}] `;
            const parents = Math.max(0, ...part.files.map(file => file.parents));
            for (let parent = 1; parent <= parents; parent++) {
                sections.push({
                    key: sections.length === 0 ? 'combined' : `part${index + 1}parent${parent}`,
                    label: `${prefix}Versus parent ${parent} (hunks)`,
                    metadata: part.metadata,
                    files: part.files
                        .filter(file => file.perParent.length >= parent)
                        .map(file => partialFile(file.perParent[parent - 1])),
                });
            }
        }
        if (!sections.length) {
            throw new Error('The combined diff contains no reviewable per-parent changes.');
        }
        return { source, digest, mode: 'partial', sections, metadata: combinedParts[0]?.metadata };
    }
    const parts = parseHunks(source.bytes, options);
    const sections = parts.map((part, index): ReviewSection => ({
        key: parts.length === 1 ? 'combined' : `part${index + 1}`,
        label: partLabel(part.metadata, index + 1, parts.length),
        metadata: part.metadata,
        files: part.files.map(partialFile),
    }));
    return { source, digest, mode: 'partial', sections, metadata: parts[0]?.metadata };
}

function snapshotFiles(applied: Pick<AppliedPatch, 'changes' | 'skipped'>): SnapshotFile[] {
    return [...applied.changes, ...applied.skipped.map(metadataFile)];
}

function metadataFile(change: SkippedChange): SnapshotFile {
    const before = metadataSide(change.oldPath, change.oldMode, change.oldId);
    const after = metadataSide(change.newPath, change.newMode, change.newId);
    const status = change.reason === 'rename' ? 'R'
        : change.oldMode === '000000' ? 'A' : change.newMode === '000000' ? 'D' : 'M';
    const note = change.reason === 'submodule' ? 'submodule pointer'
        : change.reason === 'mode' ? 'mode change' : 'rename without edits';
    return {
        status, oldPath: change.oldPath, newPath: change.newPath, before, after, kind: 'metadata', note,
    };
}

function metadataSide(file: string, mode?: string, id?: string): Buffer | undefined {
    if (mode === '000000') {
        return undefined;
    }
    return Buffer.from(`Metadata only; file contents are not displayed.\nPath: ${file}\n`
        + `Mode: ${mode ?? '(not supplied)'}\nObject: ${id ?? '(not supplied)'}\n`);
}

function partialFile(file: HunkFile): SnapshotFile {
    if (file.hasHunks && !file.binary) {
        return { ...file, note: 'partial context' };
    }
    const note = file.binary ? 'binary data not reconstructed'
        : file.oldPath !== file.newPath ? 'rename metadata only' : 'metadata only';
    const side = (name: 'before' | 'after') => {
        const content = metadataSide(
            name === 'before' ? file.oldPath : file.newPath,
            name === 'before' ? file.oldMode : file.newMode,
            name === 'before' ? file.oldId : file.newId,
        );
        if (!content || !file.binary) {
            return content;
        }
        return Buffer.from(`Binary change, ${name} side. The bytes are not reconstructed in a hunk-only view.\n\n`
            + content.toString('utf8'));
    };
    return {
        status: file.status, oldPath: file.oldPath, newPath: file.newPath, kind: 'metadata', note,
        before: file.status === 'A' ? undefined : side('before'),
        after: file.status === 'D' ? undefined : side('after'),
    };
}

function partLabel(metadata: PatchMetadata, index: number, total: number): string {
    const subject = metadata.subject?.replace(/^\[PATCH\b[^\]]*\]\s*/i, '') ?? 'Patch';
    return `[${metadata.index ?? index}/${metadata.total ?? total}] ${subject}`;
}

const SAMPLE_PATCH = [
    'diff --git a/src/greeting.ts b/src/greeting.ts',
    '--- a/src/greeting.ts',
    '+++ b/src/greeting.ts',
    '@@ -1,3 +1,3 @@',
    ' export function greeting(): string {',
    "-    return 'hello';",
    "+    return 'hello, world';",
    ' }',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,2 +1,3 @@',
    ' # Sample',
    ' A tiny example project.',
    '+It now greets the world.',
    '',
].join('\n');

function fileStatusLabel(file: SnapshotFile): string {
    if (file.kind === 'metadata' && file.note) {
        return file.note;
    }
    const labels: Record<ChangeStatus, string> = {
        A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed', T: 'type changed',
    };
    return file.note ? `${labels[file.status]} (${file.note})` : labels[file.status];
}

function isRecentPatch(value: unknown): value is RecentPatch {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.uri === 'string'
        && typeof entry.name === 'string'
        && typeof entry.digest === 'string'
        && (entry.mode === 'complete' || entry.mode === 'partial')
        && Array.isArray(entry.reviewed) && entry.reviewed.every(item => typeof item === 'string')
        && typeof entry.when === 'number'
        && (entry.repo === undefined || typeof entry.repo === 'string')
        && (entry.base === undefined || typeof entry.base === 'string')
        && (entry.commit === undefined || typeof entry.commit === 'string')
        && (entry.members === undefined
            || (Array.isArray(entry.members) && entry.members.every(item => typeof item === 'string')));
}

async function pickSources(uri: unknown, selected: unknown): Promise<readonly vscode.Uri[] | undefined> {
    if (Array.isArray(selected) && selected.length > 1) {
        return selected.filter(isUri);
    }
    if (isUri(uri)) {
        return [uri];
    }
    const document = vscode.window.activeTextEditor?.document;
    if (document && document.uri.scheme !== SCHEME
        && (document.languageId === 'diff' || looksLikePatch(document.getText()))) {
        return [document.uri];
    }
    return vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'View Patch',
        filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
    });
}

function isUri(value: unknown): value is vscode.Uri {
    return value instanceof vscode.Uri;
}

async function readSource(uri: vscode.Uri, options: OperationOptions): Promise<PatchSource> {
    const limit = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    throwIfAborted(options.signal);
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    let bytes: Uint8Array;
    if (open && (open.isDirty || open.isUntitled)) {
        const text = open.getText();
        checkPatchSize(Buffer.byteLength(text, 'utf8'), limit);
        bytes = Buffer.from(text, 'utf8');
    } else {
        checkPatchSize((await vscode.workspace.fs.stat(uri)).size, limit);
        throwIfAborted(options.signal);
        bytes = await vscode.workspace.fs.readFile(uri);
        checkPatchSize(bytes.length, limit);
    }
    return {
        uri, name: path.posix.basename(uri.path), bytes,
        folder: uri.scheme === 'file' ? path.dirname(uri.fsPath) : undefined,
    };
}

function checkPatchSize(bytes: number, limit: number): void {
    if (bytes > limit) {
        throw new OperationLimitError(
            `The patch is ${bytes} bytes; the limit is ${limit} bytes. Raise viewPatch.maxPatchSizeMiB to open it.`,
        );
    }
}

function configuredOptions(signal: AbortSignal): OperationOptions {
    return {
        signal,
        timeoutMs: settingBytes('gitTimeoutSeconds', DEFAULT_TIMEOUT_MS / 1000, 1000),
        maxPatchBytes: settingBytes('maxPatchSizeMiB', DEFAULT_MAX_PATCH_BYTES / MIB, MIB),
        maxContentBytes: settingBytes('maxContentSizeMiB', DEFAULT_MAX_CONTENT_BYTES / MIB, MIB),
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    };
}

function configuredCacheLimit(): number {
    return settingBytes('maxOpenContentMiB', DEFAULT_MAX_CACHE_BYTES / MIB, MIB);
}

function settingBytes(name: string, fallback: number, multiplier: number): number {
    const value: unknown = vscode.workspace.getConfiguration('viewPatch').get(name, fallback);
    if (typeof value !== 'number') {
        throw new Error(`viewPatch.${name} must be a positive whole number.`);
    }
    return positiveLimit(`viewPatch.${name}`, positiveLimit(`viewPatch.${name}`, value) * multiplier);
}

function candidateFolders(source: PatchSource, api: GitApi | undefined): string[] {
    const folders = knownFolders(api);
    if (source.folder) {
        folders.push(source.folder);
    }
    for (const member of source.members ?? []) {
        if (member.scheme === 'file') {
            folders.push(path.dirname(member.fsPath));
        }
    }
    return folders;
}

/** The repository starting points that exist without any patch: Git view, workspace folders, and settings. */
function knownFolders(api: GitApi | undefined): string[] {
    const folders = api?.repositories.map(repository => repository.rootUri.fsPath) ?? [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === 'file') {
            folders.push(folder.uri.fsPath);
        }
    }
    const extra = vscode.workspace.getConfiguration('viewPatch').get<unknown[]>('repositories', []);
    for (const folder of extra) {
        if (typeof folder !== 'string') {
            throw new Error('Every viewPatch.repositories entry must be a folder path.');
        }
        if (folder.trim()) {
            const value = folder.trim();
            folders.push(/^~(?=$|[\\/])/.test(value) ? path.join(os.homedir(), value.slice(1)) : value);
        }
    }
    return folders;
}

function gitExecutable(api: GitApi | undefined): string {
    if (api?.git.path) {
        return api.git.path;
    }
    const configured: unknown = vscode.workspace.getConfiguration('git').get('path');
    if (typeof configured === 'string' && configured) {
        return configured;
    }
    return 'git';
}

async function chooseTarget(
    git: Git,
    candidates: readonly string[],
    source: PatchSource,
    options: OperationOptions,
    commit?: string,
): Promise<PatchTarget | undefined> {
    const picked = await vscode.window.showQuickPick([
        ...candidates.map(repo => ({ label: path.basename(repo), description: repo, repo })),
        { label: '$(folder-opened) Browse...', description: '', repo: '' },
    ], { title: 'View Patch: repository to apply the patch in' });
    if (!picked) {
        return undefined;
    }
    let repo = picked.repo;
    if (!repo) {
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, openLabel: 'Use This Repository',
        });
        if (!folders) {
            return undefined;
        }
        repo = await topLevel(git, folders[0].fsPath, options) ?? '';
        if (!repo) {
            throw new Error('That folder is not in a Git repository.');
        }
    }
    const suggested = commit && await hasCommit(git, repo, commit, options)
        ? await parentOf(git, repo, commit, options) : 'HEAD';
    const base = (await vscode.window.showInputBox({
        title: `View Patch: base for ${source.name}`,
        prompt: 'The commit, branch, tag, or tree the patch applies to.',
        value: suggested,
        validateInput: async value => await isRevision(git, repo, value.trim(), options)
            ? undefined : `"${value.trim()}" is not a valid revision.`,
    }))?.trim();
    throwIfAborted(options.signal);
    return base ? { repo, base, applied: await applyPatch(git, repo, base, source.bytes, options) } : undefined;
}

function sectionTitle(review: Review, section: ReviewSection): string {
    return `${review.title}${review.sections.length > 1 ? ` - ${section.label}` : ''}`;
}

function matchesTitle(title: string, label: string): boolean {
    return label === title || label.startsWith(`${title} (`);
}

function allTabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs);
}

function tabUris(tab: vscode.Tab): readonly vscode.Uri[] {
    if (tab.input instanceof vscode.TabInputText) {
        return [tab.input.uri];
    }
    return tab.input instanceof vscode.TabInputTextDiff ? [tab.input.original, tab.input.modified] : [];
}

function isSingleFileTab(tab: vscode.Tab): boolean {
    return tab.input instanceof vscode.TabInputTextDiff || tab.input instanceof vscode.TabInputText;
}

async function waitForTab(check: () => boolean): Promise<void> {
    if (check()) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
            if (check()) {
                clearTimeout(timer);
                listener.dispose();
                resolve();
            }
        });
        const timer = setTimeout(() => {
            listener.dispose();
            reject(new Error('The Changes tab did not open. See the View Patch output channel.'));
        }, 10_000);
        if (check()) {
            clearTimeout(timer);
            listener.dispose();
            resolve();
        }
    });
}

function firstLines(text: string): string {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 2).join(' ');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
