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
import { AppliedPatch, applyPatch, looksLikePatch, patchCommit, SkippedChange } from './patch';
import { HunkFile, parseHunks, PatchMetadata } from './patchText';
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
    private readonly subscriptions: vscode.Disposable[] = [];
    private nextId = 1;
    private syncTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    constructor(private readonly log: vscode.LogOutputChannel) {
        this.view = vscode.window.createTreeView('viewPatch.reviews', { treeDataProvider: this.tree });
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
        return this.run(this.find(reference).source.uri, 'choose', true);
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
        } finally {
            review.opening = false;
        }
    }

    toggleReviewed(reference: unknown): void {
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
        this.tree.refresh();
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
        this.tree.refresh();
    }

    async close(reference?: unknown): Promise<void> {
        const review = this.find(reference);
        const tabs = allTabs().filter(tab => this.ownsTab(review, tab));
        if (tabs.length && !(await vscode.window.tabGroups.close(tabs, true))) {
            throw new Error('The review could not close. Its content has been kept.');
        }
        this.remove(review.id);
    }

    async reveal(): Promise<void> {
        await vscode.commands.executeCommand('viewPatch.reviews.focus');
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
        if (mode === 'choose') {
            const target = await chooseTarget(git, candidates, source, options, commit);
            return target && completeReview(source, digest, target);
        }
        const resolution = await resolvePatch(git, candidates, source.bytes, commit, options);
        for (const failure of resolution.failures) {
            this.log.info(`${source.name} does not apply on ${failure.base} in ${failure.repo}: ${failure.reason}`);
        }
        if (!resolution.targets.length) {
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
            reviewed: previous ? preserveReviewed(previous, data) : new Set(),
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
        this.tree.refresh();
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
            this.tree.refresh();
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
        const uri = document.uri.toString();
        const digest = contentFingerprint(Buffer.from(document.getText(), 'utf8'));
        const affected = [...this.reviews.values()].filter(review => {
            const contains = review.source.uri.toString() === uri
                || review.source.members?.some(member => member.toString() === uri);
            const earlier = review.source.memberDigests?.get(uri) ?? review.digest;
            return contains && digest !== earlier;
        });
        if (!affected.length) {
            return;
        }
        affected.forEach(review => review.sourceChanged = true);
        this.tree.refresh();
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
        this.documents.remove(id);
        this.reviews.delete(id);
        this.titles.delete(id);
        if (source) {
            this.recipes.delete(source);
        }
        this.tree.refresh();
        void vscode.commands.executeCommand('setContext', 'viewPatch.hasReviews', this.reviews.size > 0);
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
    const folders = api?.repositories.map(repository => repository.rootUri.fsPath) ?? [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === 'file') {
            folders.push(folder.uri.fsPath);
        }
    }
    if (source.folder) {
        folders.push(source.folder);
    }
    for (const member of source.members ?? []) {
        if (member.scheme === 'file') {
            folders.push(path.dirname(member.fsPath));
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
