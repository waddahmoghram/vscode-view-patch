// Release check A's steps (RELEASE_RUNBOOK.md section 6) as a VS Code test runner. scripts/release-checks/remote.mjs
// copies this file into a scratch folder with check-a-config.json beside it, because environment variables do not
// reach a remote extension host, and runs it in a VS Code test instance: in the local extension host, or in the
// remote one of a Remote - SSH window. run() records every step in check-a-results.json beside this file and
// resolves even when a step fails, so a rejected run means that the suite itself broke. It loads only vscode and
// Node.js built-ins, so it runs from any folder.
//
// The "provision" phase only records where the extension host runs, which locates the VS Code Server; the "check"
// phase runs the steps, calling View Patch's commands and checking what they return.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const CONFIG = path.join(__dirname, 'check-a-config.json');
const RESULTS = path.join(__dirname, 'check-a-results.json');
const PLATFORMS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

exports.run = async function run() {
    const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const results = {
        schemaVersion: 1,
        phase: config.phase,
        startedAt: new Date().toISOString(),
        host: hostFacts(),
        steps: [],
        notes: [],
        evidence: [],
    };
    try {
        if (config.phase === 'check') {
            await new Check(config, results).run();
        } else if (config.phase !== 'provision') {
            throw new Error(`unknown phase ${config.phase}`);
        }
    } catch (error) {
        results.error = message(error);
    } finally {
        results.finishedAt = new Date().toISOString();
        fs.writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
    }
};

class Check {
    constructor(config, results) {
        this.config = config;
        this.results = results;
        this.remote = config.window === 'ssh-remote';
        this.names = new Map(config.steps);
        this.patch = vscode.Uri.file(config.patch);
        this.second = vscode.Uri.file(config.secondPatch);
        this.patchName = path.posix.basename(this.patch.path);
        this.secondName = path.posix.basename(this.second.path);
    }

    async run() {
        await this.step('1', () => this.identity());
        if (!this.extension) {
            this.skip(['1a', '2', '3', '3a', '4', '5', '5a'], 'View Patch is not ready in this window (step 1)');
            return;
        }
        await this.step('1a', () => this.title());
        if (await this.step('2', () => this.open())) {
            if (await this.step('3', () => this.markAndRefresh())) {
                await this.step('3a', () => this.modeSwitches());
                const ready = await this.readyForHunks();
                if (ready === true) {
                    await this.step('4', () => this.hunksOnly());
                } else {
                    this.skip(['4'], ready);
                }
            } else {
                this.skip(['3a', '4'], 'they check the mark that step 3 sets');
            }
            await this.step('5', () => this.close());
        } else {
            this.skip(['3', '3a', '4', '5'], 'step 2 did not open the review');
        }
        await this.step('5a', () => this.output());
    }

    /** Step 1: Copy Diagnostics, after checking that the installed package is what runs here. */
    async identity() {
        const { config } = this;
        const extension = vscode.extensions.getExtension(config.extensionId);
        expect(extension, `${config.extensionId} is not installed in this extension host`);
        const loaded = extension.packageJSON.version;
        expect(loaded === config.version, `View Patch ${loaded} is loaded, not ${config.version}`);
        expect(!config.extensionsDir || inside(extension.extensionPath, config.extensionsDir),
            `View Patch was loaded from ${extension.extensionPath}, not from the package installed in`
            + ` ${config.extensionsDir}`);
        await this.within(extension.activate(), 'activating View Patch');
        const workspace = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri);
        expect(workspace.length === 1 && workspace[0].scheme === 'file' && sameFile(workspace[0].fsPath, config.clone),
            `the window's folders are ${workspace.map(String).join(', ') || '(none)'}, not the clone ${config.clone}`);
        this.extension = extension;

        const text = await this.command('viewPatch.copyDiagnostics');
        expect(typeof text === 'string', 'Copy Diagnostics returned no text; View Patch reported an error');
        this.results.evidence.push({ label: 'Copy Diagnostics', text });
        const lines = text.split(/\r?\n/);
        const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '(missing)';
        const remote = field('Remote');
        const platform = field('Platform');
        const git = field('Git version');
        const folders = field('Workspace folders');
        const here = `${process.platform} ${process.arch}; Node ${process.versions.node}`;
        const problems = [];
        if (lines[0] !== `View Patch ${config.version}`) {
            problems.push(`the first line is "${lines[0]}"`);
        }
        if (platform !== here) {
            problems.push(`Platform: ${platform}, not ${here}`);
        }
        if (this.remote && process.platform !== 'linux') {
            problems.push('the remote host is not Linux');
        }
        if (!git.startsWith('git version ')) {
            problems.push(`Git version: ${git}`);
        }
        if (folders !== '1; trusted: true') {
            problems.push(`Workspace folders: ${folders}`);
        }
        if (remote !== (this.remote ? 'ssh-remote' : '(none)')) {
            problems.push(`Remote: ${remote}`);
        }
        expect(problems.length === 0, problems.join('; '));
        const seen = `${lines[0]}; Remote: ${remote}; Platform: ${platform}; Git version: ${git};`
            + ` Workspace folders: ${folders}`;
        return this.remote ? seen : {
            substitute: true,
            detail: `a local test window stands in for the Remote - SSH window, so Remote: (none); every other line`
                + ` is as required: ${seen}`,
        };
    }

    /** Step 1a: the Patch Reviews title and Show Environment name the version and the host. */
    async title() {
        const { config } = this;
        const platform = PLATFORMS[process.platform] ?? process.platform;
        const expectedTitle = `v${config.version} · ${this.remote ? 'remote' : 'local'} ${platform}`;
        const expectedText = this.remote
            ? `View Patch ${config.version} is running on a remote ${platform} host (ssh-remote).`
            : `View Patch ${config.version} is running on this computer (${platform}).`;
        const text = await this.command('viewPatch.showEnvironment');
        // Best effort: the extension's exports reach its Patch Reviews view, since it runs in this extension host.
        const title = this.extension.exports?.reviews?.view?.description;
        const problems = [];
        if (text !== expectedText) {
            problems.push(`Show Environment said "${text}", not "${expectedText}"`);
        }
        if (typeof title === 'string' && title !== expectedTitle) {
            problems.push(`the Patch Reviews title is "${title}", not "${expectedTitle}"`);
        }
        expect(problems.length === 0, problems.join('; '));
        let seen = `Show Environment: "${text}"`;
        if (typeof title === 'string') {
            seen = `Patch Reviews title "${title}"; ${seen}`;
        } else {
            seen += '; the Patch Reviews title was not readable, so only Show Environment was checked';
            this.results.notes.push('Step 1a could not read the Patch Reviews title through the extension\'s exports.');
        }
        return this.remote ? seen : {
            substitute: true,
            detail: `a local test window stands in, so the host reads local ${platform} where a Remote - SSH window`
                + ` reads "v${config.version} · remote Linux": ${seen}`,
        };
    }

    /** Step 2: Open Patch as Changes, run with the patch as the active editor, as the Command Palette runs it. */
    async open() {
        const { config } = this;
        await this.showPatch(this.patch);
        const [review] = single(await this.command('viewPatch.open'), 'Open Patch as Changes');
        expect(review.mode === 'complete', `the review shows ${review.mode} instead of complete files`);
        expect(review.repo && sameFile(review.repo, config.clone),
            `its repository is ${review.repo ?? '(none)'}, not the clone`);
        expect(review.base === config.base, `its base is ${review.base ?? '(none)'}, not ${config.base}`);
        const files = matchFiles(review, config.files);
        const listed = await this.reviews();
        expect(listed.length === 1 && listed[0].id === review.id,
            `Patch Reviews lists ${listed.map(item => item.id).join(', ')}`);
        this.first = review;
        return `review ${review.id}, complete files, ${files.length} files (${files.join(', ')}), in the clone on`
            + ` base ${review.base}; the only review listed`;
    }

    /** Step 3: mark one file reviewed, then Refresh Review. */
    async markAndRefresh() {
        const { config, first } = this;
        expect(first.sections.length === 1, `the review has ${first.sections.length} sections, not 1`);
        await this.command('viewPatch.toggleReviewed', {
            reviewId: first.id,
            sectionKey: first.sections[0].key,
            fileIndex: fileIndex(first, config.markFile),
        });
        expect(reviewed(await this.review(first.id)) === 1, `marking ${config.markFile} reviewed did not register`);
        const refreshed = await this.command('viewPatch.refresh', { reviewId: first.id });
        this.same(refreshed, 'complete', 'Refresh Review');
        expect(refreshed.base === config.base, `Refresh Review moved the base to ${refreshed.base}`);
        return `marked ${config.markFile} reviewed; Refresh Review returned ${refreshed.id}, still complete files on`
            + ` ${refreshed.base}, 1 file reviewed`;
    }

    /** Step 3a: switch the first review to hunks only and back while a second patch's review is the active tab. */
    async modeSwitches() {
        const { config, first } = this;
        await this.showPatch(this.second);
        const [second] = single(await this.command('viewPatch.open'), `Open Patch as Changes on ${this.secondName}`);
        try {
            expect(second.id !== first.id, `${this.secondName} reused ${first.id}`);
            expect(second.mode === 'complete', `${this.secondName} opened in ${second.mode} mode`);
            matchFiles(second, config.secondFiles);
            await this.activate(second);
            this.same(await this.command('viewPatch.showHunks', { reviewId: first.id }), 'partial',
                'Show Hunks Only for Review');
            await this.unchanged(second);
            await this.activate(second);
            const complete = await this.command('viewPatch.showCompleteFiles', { reviewId: first.id });
            this.same(complete, 'complete', 'Show Complete Files for Review');
            expect(complete.base === config.base && complete.repo && sameFile(complete.repo, config.clone),
                `Show Complete Files for Review moved the target to ${complete.repo} at ${complete.base}`);
            await this.unchanged(second);
            return `with ${second.id} (${this.secondName}, complete) as the active tab before each switch, Show Hunks`
                + ` Only for Review showed ${first.id} in partial context and Show Complete Files for Review returned`
                + ` it to complete files on ${complete.base}, keeping 1 file reviewed; ${second.id} stayed complete`
                + ' with its one tab, then closed';
        } finally {
            await this.closeSecond(second);
        }
    }

    /** Step 4 has to start from the first review alone, in complete files, with its mark. */
    async readyForHunks() {
        try {
            const listed = await this.reviews();
            const first = listed.find(review => review.id === this.first.id);
            if (!first) {
                return `${this.first.id} is no longer open`;
            }
            if (first.mode !== 'complete' || reviewed(first) !== 1 || listed.length !== 1) {
                return `after step 3a, ${first.id} shows ${first.mode} with ${reviewed(first)} reviewed and`
                    + ` ${listed.length} reviews are open; step 4 starts from complete files, 1 reviewed, alone`;
            }
            return true;
        } catch (error) {
            return message(error);
        }
    }

    /** Step 4: View Patch Hunks Only with the patch as the active editor and no argument. */
    async hunksOnly() {
        const { config } = this;
        await this.showPatch(this.patch);
        const [hunks] = single(await this.command('viewPatch.openHunks'), 'View Patch Hunks Only');
        this.same(hunks, 'partial', 'View Patch Hunks Only');
        const files = matchFiles(hunks, config.files);
        const listed = await this.reviews();
        expect(listed.length === 1, `Patch Reviews lists ${listed.length} reviews`);
        const tabs = reviewTabs(hunks);
        expect(tabs.length === 1, `${hunks.id} has ${tabs.length} tabs: ${tabs.map(tab => tab.label).join(', ')}`);
        expect(tabs[0].label.includes('partial context'), `its tab reads "${tabs[0].label}"`);
        return `with ${this.patchName} as the active editor and no argument: the same review ${hunks.id} in partial`
            + ` context, ${files.length} files, 1 reviewed, the only review listed; its one tab reads`
            + ` "${tabs[0].label}"`;
    }

    /** Step 5: closing the review's last tab releases it and leaves every other tab open. */
    async close() {
        const { first } = this;
        expect((await this.reviews()).some(review => review.id === first.id), `${first.id} is no longer open`);
        const tabs = reviewTabs(first);
        expect(tabs.length > 0, `${first.id} has no tab to close`);
        const labels = tabs.map(tab => tab.label);
        const others = allTabs().map(tab => tab.label).filter(label => !labels.includes(label));
        expect(await this.within(vscode.window.tabGroups.close(tabs), 'closing the review tab'),
            'the review tab did not close');
        await this.waitFor(async () => !(await this.reviews()).some(review => review.id === first.id),
            `${first.id} to leave Patch Reviews`);
        const left = allTabs().map(tab => tab.label);
        const closed = others.filter(label => !left.includes(label));
        expect(closed.length === 0, `other tabs closed too: ${closed.join(', ')}`);
        expect(textTabs(this.patch).length > 0, `the ${this.patchName} tab closed`);
        return `closing ${first.id}'s last tab released it from Patch Reviews; the ${this.patchName} tab and the`
            + ' other tabs stayed open';
    }

    /** Step 5a: Show View Patch Output. */
    async output() {
        // Best effort: VS Code 1.148 shows the revealed output channel as a visible editor with an output: URI.
        const channel = () => vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === 'output'
            && decodeURIComponent(editor.document.uri.toString()).toLowerCase().includes(this.config.extensionId));
        const before = channel();
        await this.command('viewPatch.showOutput');
        const shown = before ?? await this.poll(channel, 5000);
        if (!shown) {
            return 'Show View Patch Output ran without an error; no output channel editor became visible to the test'
                + ' runner, so what it showed was not checked';
        }
        const state = before ? 'was' : 'became';
        return `Show View Patch Output ran without an error, and View Patch's output channel ${state} a visible editor`
            + ` (${shown.document.uri.toString()})`;
    }

    async step(id, task) {
        const name = this.names.get(id) ?? id;
        try {
            const outcome = await task();
            const { detail, substitute } = typeof outcome === 'string' ? { detail: outcome } : outcome;
            if (this.remote || substitute) {
                this.add(id, name, substitute ? 'substitute' : 'pass', detail);
            } else {
                // A step in a local window only stands in for the same step in a Remote - SSH window.
                this.add(id, name, 'substitute', `in a local test window: ${detail}`);
            }
            return true;
        } catch (error) {
            this.add(id, name, 'fail', message(error));
            return false;
        }
    }

    skip(ids, reason) {
        for (const id of ids) {
            this.add(id, this.names.get(id) ?? id, 'not run', reason);
        }
    }

    add(id, name, status, detail) {
        this.results.steps.push({ id, name, status, detail });
        console.log(`CHECK ${status.toUpperCase()} ${id}. ${name}: ${detail}`);
    }

    /** The command's result. Each command has a time limit, so a hang fails its step instead of the whole run. */
    command(id, ...args) {
        return this.within(vscode.commands.executeCommand(id, ...args), id);
    }

    within(thenable, what) {
        const ms = this.config.commandTimeoutMs;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
        });
        return Promise.race([Promise.resolve(thenable), timeout]).finally(() => clearTimeout(timer));
    }

    async waitFor(check, what, ms = 15_000) {
        const deadline = Date.now() + ms;
        while (!(await check())) {
            expect(Date.now() < deadline, `timed out waiting for ${what}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /** The first truthy value of `probe` within `ms`, or undefined. */
    async poll(probe, ms) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const value = probe();
            if (value) {
                return value;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return undefined;
    }

    async reviews() {
        const listed = await this.command('viewPatch.listReviews');
        expect(Array.isArray(listed), 'viewPatch.listReviews returned no list');
        return listed;
    }

    async review(id) {
        const found = (await this.reviews()).find(review => review.id === id);
        expect(found, `${id} is no longer open`);
        return found;
    }

    async showPatch(uri) {
        const name = path.posix.basename(uri.path);
        await this.within(vscode.window.showTextDocument(uri, { preview: false }), `opening ${name}`);
        expect(vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
            `${name} is not the active editor`);
    }

    /** Makes the review's tab the active one, as selecting it in Patch Reviews does. */
    async activate(review) {
        if (!this.isActive(review)) {
            await this.command('viewPatch.showReview', { reviewId: review.id });
        }
        expect(this.isActive(review), `${review.id}'s tab is not the active tab`);
    }

    isActive(review) {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        return Boolean(active) && reviewTabs(review).some(tab => tab.label === active.label);
    }

    same(shown, mode, what) {
        const { first } = this;
        expect(shown && shown.id === first.id, `${what} returned ${shown?.id ?? 'nothing'} instead of ${first.id}`);
        expect(shown.mode === mode, `${what} left ${first.id} in ${shown.mode} mode, not ${mode}`);
        expect(reviewed(shown) === 1, `${what} lost the checkmark: ${reviewed(shown)} files reviewed`);
    }

    async unchanged(second) {
        const now = await this.review(second.id);
        expect(now.mode === 'complete' && now.base === second.base && reviewed(now) === reviewed(second),
            `${second.id} changed: ${now.mode} on ${now.base}, ${reviewed(now)} reviewed`);
        const tabs = reviewTabs(now);
        expect(tabs.length === 1, `${second.id} has ${tabs.length} tabs`);
    }

    async closeSecond(second) {
        try {
            if ((await this.reviews()).some(review => review.id === second.id)) {
                await this.command('viewPatch.closeReview', { reviewId: second.id });
            }
            await this.within(vscode.window.tabGroups.close(textTabs(this.second)), `closing ${this.secondName}`);
        } catch (error) {
            this.results.notes.push(`Closing the second review after step 3a failed: ${message(error)}`);
        }
    }
}

function hostFacts() {
    return {
        remoteName: vscode.env.remoteName ?? null,
        appName: vscode.env.appName,
        appHost: vscode.env.appHost,
        appRoot: vscode.env.appRoot,
        vscodeVersion: vscode.version,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        server: vscode.env.remoteName ? serverFolders() : null,
    };
}

/**
 * The folder options of the VS Code Server process that started this remote extension host, from its command line
 * on Linux. Only these values are kept, since the command line can also carry a connection token. Assumes that the
 * server itself is the parent process of its extension hosts.
 */
function serverFolders() {
    try {
        const args = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
        const option = name => {
            const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
            if (index < 0) {
                return null;
            }
            return args[index] === name ? args[index + 1] ?? null : args[index].slice(name.length + 1);
        };
        return {
            pid: process.ppid,
            serverDataDir: option('--server-data-dir'),
            extensionsDir: option('--extensions-dir'),
        };
    } catch (error) {
        return { pid: process.ppid, error: message(error) };
    }
}

function single(shown, what) {
    expect(Array.isArray(shown), `${what} returned nothing; View Patch reported an error (see its log)`);
    expect(shown.length === 1, `${what} returned ${shown.length} reviews, not 1`);
    return shown;
}

/** The review's files, named as in `expected`; throws unless they are exactly those. */
function matchFiles(review, expected) {
    const paths = review.resources.map(([label]) => vscode.Uri.parse(label).path);
    const names = paths.map(file => expected.find(name => file === `/${name}` || file.endsWith(`/${name}`))
        ?? path.posix.basename(file));
    const missing = expected.filter(name => !names.includes(name));
    expect(paths.length === expected.length && missing.length === 0,
        `the review lists ${names.join(', ') || 'no files'}, not ${expected.join(', ')}`);
    return names;
}

function fileIndex(review, name) {
    const index = review.resources.findIndex(([label]) => vscode.Uri.parse(label).path.endsWith(`/${name}`));
    expect(index >= 0, `${name} is not in the review`);
    return index;
}

function reviewed(shown) {
    return shown.sections.reduce((sum, section) => sum + section.reviewed, 0);
}

/** A review's Changes tabs: titled "<patch> [Patch <n>]" or "<patch> [Patch <n>: partial context]", maybe a count. */
function reviewTabs(review) {
    const stem = review.title.replace(/(: partial context)?\]$/, '');
    const titles = [`${stem}]`, `${stem}: partial context]`];
    return allTabs().filter(tab => !(tab.input instanceof vscode.TabInputText)
        && !(tab.input instanceof vscode.TabInputTextDiff)
        && titles.some(title => tab.label === title || tab.label.startsWith(`${title} (`)));
}

function textTabs(uri) {
    return allTabs().filter(tab => tab.input instanceof vscode.TabInputText
        && tab.input.uri.toString() === uri.toString());
}

function allTabs() {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs);
}

function sameFile(a, b) {
    try {
        return canonical(a) === canonical(b);
    } catch {
        return false;
    }
}

function inside(file, folder) {
    try {
        return canonical(file).startsWith(canonical(folder) + path.sep);
    } catch {
        return false;
    }
}

/** The native real path, which on Windows also expands short names such as RUNNER~1. */
function canonical(file) {
    return fs.realpathSync.native(file);
}

function expect(condition, text) {
    if (!condition) {
        throw new Error(text);
    }
}

function message(error) {
    return error instanceof Error ? error.message : String(error);
}
