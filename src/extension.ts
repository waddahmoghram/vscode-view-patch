import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PatchDocuments, SCHEME } from './documents';
import { Git } from './git';
import { applyPatch, looksLikePatch, patchCommit, SkippedChange } from './patch';
import {
    findRepositories,
    hasCommit,
    isRevision,
    parentOf,
    PatchTarget,
    Resolution,
    resolvePatch,
    topLevel,
} from './repositories';

/** What a View Patch command opened. Commands return a list of these, for scripts and tests. */
export interface ShownPatch {
    readonly title: string;
    readonly repo: string;
    readonly base: string;
    /** The label, before, and after document of each file, as URI strings; an absent side is undefined. */
    readonly resources: readonly (readonly [string, string | undefined, string | undefined])[];
}

interface PatchSource {
    readonly name: string;
    readonly folder?: string;
    readonly bytes: Uint8Array;
    readonly text: string;
}

// The parts of the built-in Git extension's API that View Patch reads.
interface GitApi {
    readonly git: { readonly path: string };
    readonly repositories: readonly { readonly rootUri: vscode.Uri }[];
}

interface GitExtension {
    readonly enabled: boolean;
    getAPI(version: 1): GitApi;
}

const CHOOSE = 'Choose Repository and Base...';
const OPEN_SETTINGS = 'Open Settings';

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    const documents = new PatchDocuments();
    log = vscode.window.createOutputChannel('View Patch', { log: true });
    context.subscriptions.push(
        log,
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
        vscode.commands.registerCommand('viewPatch.open', (uri?: unknown, selected?: unknown) =>
            openPatches(documents, uri, selected, false),
        ),
        vscode.commands.registerCommand('viewPatch.openWith', (uri?: unknown) =>
            openPatches(documents, uri, undefined, true),
        ),
    );
}

async function openPatches(
    documents: PatchDocuments,
    uri: unknown,
    selected: unknown,
    choose: boolean,
): Promise<ShownPatch[]> {
    const shown: ShownPatch[] = [];
    if (!vscode.workspace.isTrusted) {
        askForTrust();
        return shown;
    }
    let sources: PatchSource[] | undefined;
    try {
        sources = await pickSources(uri, selected);
    } catch (error) {
        report(error);
        return shown;
    }
    for (const source of sources ?? []) {
        try {
            const progress = { location: vscode.ProgressLocation.Window, title: `View Patch: ${source.name}` };
            const result = await vscode.window.withProgress(progress, () => openPatch(documents, source, choose));
            if (result) {
                shown.push(result);
            }
        } catch (error) {
            report(error, source.name);
        }
    }
    return shown;
}

function askForTrust(): void {
    const manage = 'Manage Workspace Trust';
    void vscode.window
        .showWarningMessage('View Patch runs Git, so it only opens patches in a trusted workspace.', manage)
        .then(answer => answer === manage && vscode.commands.executeCommand('workbench.trust.manage'));
}

// The Explorer passes the clicked file and the whole selection; the editor title button passes the editor's file.
async function pickSources(uri: unknown, selected: unknown): Promise<PatchSource[] | undefined> {
    const uris = Array.isArray(selected) && selected.length > 1 ? selected.filter(isUri) : isUri(uri) ? [uri] : [];
    if (uris.length > 0) {
        return Promise.all(uris.map(readSource));
    }
    const document = vscode.window.activeTextEditor?.document;
    if (document && (document.languageId === 'diff' || looksLikePatch(document.getText()))) {
        return [documentSource(document)];
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'View Patch',
        filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
    });
    return picked && Promise.all(picked.map(readSource));
}

function isUri(value: unknown): value is vscode.Uri {
    return value instanceof vscode.Uri;
}

async function readSource(uri: vscode.Uri): Promise<PatchSource> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (open && (open.isDirty || open.isUntitled)) {
        return documentSource(open);
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    return { name: path.posix.basename(uri.path), folder: folderOf(uri), bytes, text };
}

function documentSource(document: vscode.TextDocument): PatchSource {
    const text = document.getText();
    return {
        name: path.posix.basename(document.uri.path),
        folder: folderOf(document.uri),
        bytes: Buffer.from(text, 'utf8'),
        text,
    };
}

function folderOf(uri: vscode.Uri): string | undefined {
    return uri.scheme === 'file' ? path.dirname(uri.fsPath) : undefined;
}

async function openPatch(
    documents: PatchDocuments,
    source: PatchSource,
    choose: boolean,
): Promise<ShownPatch | undefined> {
    if (!looksLikePatch(source.text)) {
        throw new Error('this is not a patch: it has no "diff --git" header, and no "---" line followed by "+++".');
    }
    const api = await gitApi();
    const git = new Git(api?.git.path || 'git');
    const candidates = await findRepositories(git, candidateFolders(source, api));
    const commit = patchCommit(source.text);
    log.info(`${source.name}: commit ${commit ?? '(none)'}; repositories: ${candidates.join(', ') || '(none)'}`);

    if (choose) {
        const target = await chooseTarget(git, candidates, source, commit);
        return target && show(documents, source, target);
    }

    const resolution = await resolvePatch(git, candidates, source.bytes, commit);
    for (const failure of resolution.failures) {
        log.info(`${source.name} does not apply on ${failure.base} in ${failure.repo}: ${failure.reason}`);
    }
    if (resolution.targets.length === 0) {
        offerChoice(documents, source, explain(source, candidates, commit, resolution), candidates.length === 0);
        return undefined;
    }
    const target = resolution.targets.length === 1 ? resolution.targets[0] : await pickTarget(resolution.targets);
    return target && show(documents, source, target);
}

async function gitApi(): Promise<GitApi | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
        return undefined;
    }
    try {
        const exports = extension.isActive ? extension.exports : await extension.activate();
        return exports.enabled ? exports.getAPI(1) : undefined;
    } catch (error) {
        log.warn(`The built-in Git extension is not available: ${message(error)}`);
        return undefined;
    }
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
    const extra = vscode.workspace.getConfiguration('viewPatch').get<unknown[]>('repositories', []);
    for (const folder of extra) {
        if (typeof folder === 'string' && folder.trim() !== '') {
            folders.push(expandHome(folder.trim()));
        }
    }
    return folders;
}

function expandHome(folder: string): string {
    return /^~(?=$|[\\/])/.test(folder) ? path.join(os.homedir(), folder.slice(1)) : folder;
}

function explain(
    source: PatchSource,
    candidates: readonly string[],
    commit: string | undefined,
    resolution: Resolution,
): string {
    if (candidates.length === 0) {
        return `View Patch: there is no Git repository to apply ${source.name} in. Open the repository it belongs to, `
            + 'or add its folder to the "viewPatch.repositories" setting.';
    }
    const failure = resolution.failures[0];
    const reason = failure ? ` ${firstLines(failure.reason)}` : '';
    if (resolution.commitRepo) {
        return `View Patch: ${source.name} does not apply on ${describeBase(failure?.base ?? '')} `
            + `in ${path.basename(resolution.commitRepo)}.${reason}`;
    }
    const names = candidates.map(repo => path.basename(repo)).join(', ');
    const missing = commit ? `commit ${commit.slice(0, 12)} is not in ${names}, and ` : '';
    return `View Patch: ${missing}${source.name} does not apply to HEAD in ${names}.${reason}`;
}

function offerChoice(documents: PatchDocuments, source: PatchSource, text: string, offerSettings: boolean): void {
    const actions = offerSettings ? [CHOOSE, OPEN_SETTINGS] : [CHOOSE];
    void vscode.window.showErrorMessage(text, ...actions).then(async answer => {
        try {
            if (answer === CHOOSE) {
                await openPatch(documents, source, true);
            } else if (answer === OPEN_SETTINGS) {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'viewPatch.repositories');
            }
        } catch (error) {
            report(error, source.name);
        }
    });
}

async function pickTarget(targets: readonly PatchTarget[]): Promise<PatchTarget | undefined> {
    const picked = await vscode.window.showQuickPick(
        targets.map(target => ({ label: path.basename(target.repo), description: target.repo, target })),
        { title: 'View Patch: the patch applies in more than one repository. Which one?' },
    );
    return picked?.target;
}

async function chooseTarget(
    git: Git,
    candidates: readonly string[],
    source: PatchSource,
    commit: string | undefined,
): Promise<PatchTarget | undefined> {
    const repo = await pickRepository(git, candidates);
    if (!repo) {
        return undefined;
    }
    const suggested = commit && (await hasCommit(git, repo, commit)) ? await parentOf(git, repo, commit) : 'HEAD';
    const name = path.basename(repo);
    const base = (
        await vscode.window.showInputBox({
            title: `View Patch: base for ${source.name}`,
            prompt: `The commit, branch, or tag in ${name} that the patch applies to.`,
            value: suggested,
            validateInput: async value => {
                const revision = value.trim();
                const known = await isRevision(git, repo, revision);
                return known ? undefined : `"${revision}" is not a commit in ${name}.`;
            },
        })
    )?.trim();
    if (!base) {
        return undefined;
    }
    return { repo, base, applied: await applyPatch(git, repo, base, source.bytes) };
}

async function pickRepository(git: Git, candidates: readonly string[]): Promise<string | undefined> {
    const items: (vscode.QuickPickItem & { repo?: string })[] = [
        ...candidates.map(repo => ({ label: path.basename(repo), description: repo, repo })),
        { label: '$(folder-opened) Browse...' },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'View Patch: repository to apply the patch in' });
    if (!picked) {
        return undefined;
    }
    if (picked.repo) {
        return picked.repo;
    }
    const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: 'Use This Repository',
    });
    if (!folders) {
        return undefined;
    }
    const repo = await topLevel(git, folders[0].fsPath);
    if (!repo) {
        throw new Error(`${folders[0].fsPath} is not in a Git repository.`);
    }
    return repo;
}

async function show(
    documents: PatchDocuments,
    source: PatchSource,
    target: PatchTarget,
): Promise<ShownPatch | undefined> {
    const { changes, skipped } = target.applied;
    log.info(`${source.name}: applied on ${target.base} in ${target.repo}; ${changes.length} changed file(s)`);
    if (changes.length === 0) {
        const detail = skipped.length > 0 ? `; ${describeSkipped(skipped)}` : '';
        void vscode.window.showInformationMessage(`View Patch: ${source.name} changes no file contents${detail}.`);
        return undefined;
    }
    if (skipped.length > 0) {
        void vscode.window.showInformationMessage(
            `View Patch: not shown from ${source.name}, because no content changed: ${describeSkipped(skipped)}.`,
        );
    }
    const resources = documents.add(target.repo, changes);
    // The Changes editor adds its own file count to the title.
    const title = source.name;
    await vscode.commands.executeCommand('vscode.changes', title, resources);
    return {
        title,
        repo: target.repo,
        base: target.base,
        resources: resources.map(
            ([label, before, after]) => [label.toString(), before?.toString(), after?.toString()] as const,
        ),
    };
}

function describeSkipped(skipped: readonly SkippedChange[]): string {
    const describe = (change: SkippedChange): string => {
        switch (change.reason) {
            case 'submodule':
                return `submodule ${change.newPath}`;
            case 'mode':
                return `mode change of ${change.newPath}`;
            case 'rename':
                return `rename of ${change.oldPath} to ${change.newPath}`;
        }
    };
    const listed = skipped.slice(0, 3).map(describe);
    if (skipped.length > 3) {
        listed.push(`${skipped.length - 3} more`);
    }
    return listed.join(', ');
}

function describeBase(base: string): string {
    if (/^[0-9a-f]{40,64}\^$/.test(base)) {
        return `${base.slice(0, 12)}^`;
    }
    return /^[0-9a-f]{40,64}$/.test(base) ? 'an empty tree' : base;
}

function firstLines(text: string): string {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(' ');
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function report(error: unknown, name?: string): void {
    const text = message(error);
    log.error(name ? `${name}: ${text}` : text);
    void vscode.window.showErrorMessage(`View Patch: ${name ? `${name}: ` : ''}${firstLines(text)}`);
}
