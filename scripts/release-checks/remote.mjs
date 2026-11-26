// Release check A (RELEASE_RUNBOOK.md section 6) as an automated run: the published package in a VS Code window on
// a fresh clone, with a test runner calling View Patch's commands and checking what they return.
//
//   xvfb-run -a node scripts/release-checks/remote.mjs --version 0.3.9 [--vscode 1.148.0]
//   node scripts/release-checks/remote.mjs --version 0.3.9 --ssh <alias> --dry-run
//   node scripts/release-checks/remote.mjs --help
//
// By default the steps run in a local VS Code test instance with the package installed in an empty profile, which
// stands in for a Remote - SSH window, so every step in the window passes only through a substitute, and
// RELEASE_RUNBOOK.md section 6 says which of those count. With --ssh <alias>, the
// clone, its preflight, and the steps run on that host in a real Remote - SSH window. That installs the Remote - SSH
// extension in the test profile and a VS Code Server on the host, which accepts their licenses, so it runs only
// with --accept-server-license, which only the repository owner may pass. --dry-run does every step that needs no
// license, prints the settings and launch arguments the real run would use, and exits 3 (incomplete).
//
// NOT RUN YET: SSH mode without --dry-run has never run. Comments starting with "Assumes" mark what it relies on.
// Local mode and the SSH dry run have run on Linux only. The shell steps need a POSIX sh with git, find, and cksum,
// which on Windows means running from Git Bash.
//
// Exit codes: 0 pass, 1 a step failed, 2 bad arguments or the check could not start, 3 incomplete.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { readVSIXPackage } from '@vscode/vsce/out/zip.js';
import {
    LOCAL_SSH_ALIAS, killTree, lastLines, localHost, run, runCommands, shellQuote, sshHost, startLocalSshd,
    stopRunning,
} from './hosts.mjs';
import { CheckReport, EXIT, STATUS_TEXT, errorText } from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(path.dirname(here));
const windows = process.platform === 'win32';
const EXTENSION_ID = 'waddahmoghram.view-patch';
const MARKETPLACE = 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/waddahmoghram/vsextensions'
    + '/view-patch';
const PRE_RELEASE_PROPERTY = 'Microsoft.VisualStudio.Code.PreRelease';
const REMOTE_SSH = 'ms-vscode-remote.remote-ssh';
const SUITE_FILE = 'check-a-suite.cjs';
const CONFIG_FILE = 'check-a-config.json';
const RESULTS_FILE = 'check-a-results.json';
const PATCH = 'remote-check.patch';
const SECOND_PATCH = 'second-check.patch';
const COMMAND_TIMEOUT_MS = 90_000;
const LAUNCH_TIMEOUT_MS = 15 * 60_000;
// The first Remote - SSH launch also downloads and starts the VS Code Server.
const PROVISION_TIMEOUT_MS = 20 * 60_000;
// The flags that runTests() of @vscode/test-electron passes. This script launches VS Code itself, so that it can
// stop a run that hangs and print the exact arguments in a dry run.
const TEST_FLAGS = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome',
    '--skip-release-notes', '--no-cached-data', '--disable-workspace-trust'];
// VS Code needs a development extension to run a test runner; this one contributes nothing.
const STUB = `${JSON.stringify({
    name: 'check-a-stub',
    publisher: 'view-patch-checks',
    version: '0.0.0',
    engines: { vscode: '*' },
})}\n`;

const SUITE_STEPS = [
    ['1', 'Identity gate'],
    ['1a', 'Title'],
    ['2', 'Open Patch as Changes'],
    ['3', 'Mark and refresh'],
    ['3a', 'Mode switches with a second review open'],
    ['4', 'View Patch Hunks Only'],
    ['5', 'Close'],
    ['5a', 'Show View Patch Output'],
];
const SUITE_IDS = SUITE_STEPS.map(([id]) => id);
const LOCAL_STEPS = [
    ['package', 'Package identity'],
    ['editor', 'VS Code test instance'],
    ['clone', 'Fresh clone and preflight'],
    ['profile', 'Fresh test profile'],
    ['launch', 'Test window'],
    ...SUITE_STEPS,
    ['after', 'After check'],
];
const sshSteps = localSshd => [
    ['package', 'Package identity'],
    ['editor', 'VS Code test instance'],
    ...(localSshd ? [['sshd', 'Throwaway sshd']] : []),
    ['ssh', 'SSH preflight'],
    ['clone', 'Fresh clone and preflight'],
    ['stage', 'Suite on the host'],
    ['remote-ssh', 'Remote - SSH in the test profile'],
    ['server', 'VS Code Server'],
    ['install', 'Package on the server'],
    ['launch', 'Remote - SSH window'],
    ...SUITE_STEPS,
    ['after', 'After check'],
];

const USAGE = `Usage: node scripts/release-checks/remote.mjs --version <x.y.z> [options]

  --version <x.y.z>              the View Patch version under test (required)
  --channel regular|pre-release  the channel it was published on (default: regular)
  --vsix <file>                  test this package instead of the version's Marketplace download
  --vscode <version|stable>      VS Code for the test instance (default: $VSCODE_TEST_VERSION, else stable);
                                 the 0.3.8 checks used 1.148.0
  --out <dir>                    report folder (default: .release-checks/check-a)
  --repo-url <url>               repository to clone (default: https://github.com/waddahmoghram/vscode-view-patch.git)
  --commit <sha>                 commit of remote-check.patch (default: eabcdbe, four files, parent d5d2748)
  --second-commit <sha>          commit of second-check.patch (default: f9ce6f0, RELEASE_RUNBOOK.md only)
  --keep                         keep the scratch folders and say where they are

SSH mode:
  --ssh <alias>                  run in a Remote - SSH window on this ssh host alias (lowercase letters, digits,
                                 dots, underscores, and hyphens)
  --ssh-config <file>            ssh configuration that defines the alias (default: ssh's own)
  --server-install-path <dir>    remote folder for the VS Code Server (default: a scratch folder, removed after)
  --local-sshd                   start a throwaway sshd on 127.0.0.1 and use the alias ${LOCAL_SSH_ALIAS}
  --dry-run                      do every step that needs no license, then stop
  --accept-server-license        accept the VS Code Server and Remote - SSH licenses (repository owner only)`;

const LICENSE = `SSH mode installs the Remote - SSH extension (${REMOTE_SSH}) in the test profile and a VS Code
Server on the remote host. That requires accepting the Visual Studio Code Server license
(https://code.visualstudio.com/license/server) and the Remote - SSH extension's license
(https://marketplace.visualstudio.com/items/ms-vscode-remote.remote-ssh/license), so this mode runs only with
--accept-server-license, and only the repository owner may pass that flag. Nothing was started.
--dry-run runs every step that needs no license and prints the settings and launch arguments the real run uses.`;

/** The steps of this mode in report order, and which of them have been recorded. */
class Plan {
    constructor(report, steps) {
        this.report = report;
        this.names = new Map(steps);
        this.recorded = new Set();
    }

    async run(id, task, options) {
        const passed = await this.report.run(id, this.names.get(id), task, options);
        // Only now: a step that a signal interrupts is still left for skipRest().
        this.recorded.add(id);
        this.print();
        return passed;
    }

    record(id, status, detail, name) {
        this.recorded.add(id);
        const add = { pass: 'pass', fail: 'fail', substitute: 'substitute', 'not run': 'notRun' }[status] ?? 'fail';
        this.report[add](id, this.names.get(id) ?? name ?? id, detail);
        this.print();
    }

    skip(ids, reason) {
        for (const id of ids) {
            if (!this.recorded.has(id)) {
                this.record(id, 'not run', reason);
            }
        }
    }

    skipRest(reason) {
        this.skip([...this.names.keys()], reason);
    }

    print() {
        const step = this.report.steps.at(-1);
        console.log(`Check A: ${STATUS_TEXT[step.status]} ${step.id}. ${step.name}`);
    }
}

/** What to undo at the end, last first: a synchronous form of each task for signal handlers, and an async form. */
class Cleanup {
    constructor(onError) {
        this.onError = onError;
        this.tasks = [];
    }

    add(label, sync, async = sync) {
        const task = { label, sync, async };
        this.tasks.push(task);
        return task;
    }

    remove(task) {
        const index = this.tasks.indexOf(task);
        if (index >= 0) {
            this.tasks.splice(index, 1);
        }
    }

    async run() {
        // One task at a time, so that a signal in the middle still finds the rest for runSync().
        while (this.tasks.length > 0) {
            const task = this.tasks.at(-1);
            try {
                await task.async();
            } catch (error) {
                this.onError(task.label, error);
            }
            this.remove(task);
        }
    }

    runSync() {
        for (const task of this.tasks.splice(0).reverse()) {
            try {
                task.sync();
            } catch (error) {
                this.onError(task.label, error);
            }
        }
    }
}

class CheckA {
    constructor(options) {
        this.options = options;
        const { ssh, dryRun } = options;
        this.report = new CheckReport({
            check: 'A',
            title: `Check A in ${ssh ? 'a Remote - SSH window' : 'a local test instance'}${dryRun ? ' (dry run)' : ''}`,
            target: {
                'View Patch': `${options.version} (${options.channel})`,
                Editor: `VS Code ${options.vscode}`,
                Window: ssh
                    ? `Remote - SSH to ${ssh}${dryRun ? ' (dry run: no window opened)' : ''}`
                    : 'local test instance (substitute for a Remote - SSH window)',
                Repository: `fresh clone of ${options.repoUrl}`,
            },
        });
        this.plan = new Plan(this.report, ssh ? sshSteps(options.localSshd) : LOCAL_STEPS);
        this.cleanup = new Cleanup((label, error) => {
            console.error(`Cleaning up ${label} failed: ${errorText(error)}`);
            this.report.note(`Cleaning up ${label} failed: ${errorText(error)}`);
        });
    }

    async run() {
        const interrupted = signal => {
            console.error(`${signal}: stopping the check and cleaning up.`);
            stopRunning();
            this.cleanup.runSync();
            this.plan.skipRest(`the run was interrupted by ${signal}`);
            try {
                this.report.write(this.options.out);
            } catch (error) {
                console.error(`The report could not be written: ${errorText(error)}`);
            }
            process.exit(signal === 'SIGINT' ? 130 : 143);
        };
        process.on('SIGINT', interrupted);
        process.on('SIGTERM', interrupted);
        try {
            this.scratch = await mkdtemp(path.join(tmpdir(), 'view-patch-check-a-'));
            const scratch = this.scratch;
            this.cleanup.add('the local scratch folder', () => this.keepOrRemove(scratch));
            await this.steps();
        } catch (error) {
            this.report.note(`The run stopped early: ${errorText(error)}`);
            this.plan.skipRest(`the run stopped early: ${errorText(error)}`);
        } finally {
            await this.cleanup.run();
            process.removeListener('SIGINT', interrupted);
            process.removeListener('SIGTERM', interrupted);
        }
        return this.report.write(this.options.out);
    }

    async steps() {
        const pkg = await this.packageStep();
        if (!pkg) {
            this.plan.skipRest('the package step failed');
            return;
        }
        const editor = await this.editorStep();
        if (!editor) {
            this.plan.skipRest('there is no VS Code test instance');
            return;
        }
        await (this.options.ssh ? this.sshCheck(pkg, editor) : this.localCheck(pkg, editor));
    }

    async packageStep() {
        const { version, channel, vsix } = this.options;
        let pkg;
        await this.plan.run('package', async () => {
            const file = vsix ?? path.join(this.scratch, `view-patch-${version}.vsix`);
            if (!vsix) {
                await writeFile(file, await downloadPackage(`${MARKETPLACE}/${version}/vspackage`));
            }
            const bytes = await readFile(file);
            const digest = createHash('sha256').update(bytes).digest('hex');
            this.report.target['View Patch'] = `${version} (${channel}), package SHA-256 ${digest}`;
            const source = vsix ?? 'the Marketplace download';
            if (bytes.subarray(0, 2).toString('latin1') !== 'PK') {
                const start = bytes.subarray(0, 4).toString('hex');
                throw new Error(`${source} is not a ZIP package: it starts with ${start}`);
            }
            const { manifest, xmlManifest } = await readVSIXPackage(file);
            const metadata = xmlManifest.PackageManifest.Metadata[0];
            const identity = metadata.Identity[0].$;
            const preRelease = (metadata.Properties?.[0]?.Property ?? []).filter(property =>
                property.$.Id === PRE_RELEASE_PROPERTY && property.$.Value === 'true').length > 0;
            const found = `${source}, ${bytes.length} bytes, SHA-256 ${digest}: the manifest reads`
                + ` Version="${identity.Version}" and has ${preRelease ? 'the' : 'no'} pre-release property`;
            const problems = [];
            if (`${identity.Publisher}.${identity.Id}` !== EXTENSION_ID) {
                problems.push(`it is ${identity.Publisher}.${identity.Id}, not ${EXTENSION_ID}`);
            }
            if (identity.Version !== version || manifest.version !== version) {
                problems.push(`its version is ${identity.Version} (package.json ${manifest.version}), not ${version}`);
            }
            if (preRelease !== (channel === 'pre-release')) {
                problems.push(channel === 'pre-release' ? 'a pre-release needs the pre-release property'
                    : 'a regular release must not have the pre-release property');
            }
            if (problems.length > 0) {
                throw new Error(`${found}, but ${problems.join(', and ')}`);
            }
            pkg = { file, digest };
            return found;
        });
        return pkg;
    }

    async editorStep() {
        let editor;
        await this.plan.run('editor', async () => {
            const executable = await downloadAndUnzipVSCode({
                version: this.options.vscode,
                cachePath: path.join(root, '.vscode-test'),
            });
            const app = process.platform === 'darwin'
                ? path.join(path.dirname(path.dirname(executable)), 'Resources', 'app')
                : path.join(path.dirname(executable), 'resources', 'app');
            const { version } = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
            const { commit } = JSON.parse(await readFile(path.join(app, 'product.json'), 'utf8'));
            // The helper also returns arguments for the shared .vscode-test profile; this run uses its own instead.
            const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
            editor = { executable, cli, version, commit };
            this.report.target.Editor = `VS Code ${version}`;
            return `VS Code ${version} (asked for ${this.options.vscode}), commit ${commit}, ${executable}`;
        });
        return editor;
    }

    async localCheck(pkg, editor) {
        const host = localHost();
        // The shell scripts and the suite get forward slashes, which Git for Windows' sh and Node.js both accept.
        const base = this.scratch.split(path.sep).join('/');
        const clone = await this.cloneStep(host, async () => base);
        if (!clone) {
            this.plan.skipRest('the clone step failed');
            return;
        }
        const profile = profilePaths(this.scratch);
        const suiteDir = path.posix.join(base, 'suite');
        const stubDir = path.posix.join(base, 'stub');
        const ready = await this.plan.run('profile', async () => {
            await writeSettings(profile, this.settings());
            const said = await this.installInProfile(editor, profile, pkg.file);
            const folders = await readdir(profile.extensions);
            if (!folders.some(name => name.startsWith(`${EXTENSION_ID}-${this.options.version}`))) {
                throw new Error(`after "${said}", the extensions folder holds ${folders.join(', ') || 'nothing'}`);
            }
            await this.stage(host, suiteDir, stubDir, this.suiteConfig('check', clone, profile.extensions));
            return `the VS Code CLI installed the package into a fresh extensions folder ("${said}"); fresh user data`
                + ' with updates, telemetry, and Git auto fetch off; the suite and an inert development extension';
        });
        if (ready) {
            const args = [clone.dir, ...profile.args, ...TEST_FLAGS, `--extensionDevelopmentPath=${stubDir}`,
                `--extensionTestsPath=${path.posix.join(suiteDir, SUITE_FILE)}`];
            const launch = await this.launch(editor, args, 'vscode.log', LAUNCH_TIMEOUT_MS);
            this.recordSuite(launch, await readResults(host, suiteDir), editor, 'its local extension host');
        } else {
            this.plan.skip(['launch', ...SUITE_IDS], 'the test profile step failed');
        }
        await this.afterStep(host, clone);
        await this.attachLog(host, path.posix.join(base, 'profile', 'user', 'logs'));
        this.report.note('A local VS Code test instance stood in for a Remote - SSH window: the extension host ran on'
            + ' this computer, so every step in the window passes only through a substitute, and RELEASE_RUNBOOK.md'
            + ' section 6 says which of them count. Run with --ssh to cover the VS Code Server and a remote extension'
            + ' host.');
    }

    async sshCheck(pkg, editor) {
        const { options } = this;
        let configFile = options.sshConfig;
        if (options.localSshd) {
            const started = await this.plan.run('sshd', async () => {
                const sshd = await startLocalSshd();
                this.cleanup.add('the throwaway sshd', () => sshd.stopSync(), () => sshd.stop());
                configFile = sshd.configFile;
                return `a user-level sshd on 127.0.0.1 port ${sshd.port} with throwaway ed25519 host and client keys;`
                    + ` the alias ${sshd.alias} in a generated ssh configuration`;
            });
            if (!started) {
                this.plan.skipRest('the throwaway sshd did not start');
                return;
            }
        }
        const host = sshHost(options.ssh, configFile);
        const reached = await this.plan.run('ssh', async () => {
            const facts = await runCommands(host, { git: 'git --version', system: 'uname -sm' });
            const git = output(facts, 'git', 'git --version').trim();
            const system = output(facts, 'system', 'uname -sm').trim();
            if (!system.startsWith('Linux ')) {
                throw new Error(`${options.ssh} runs ${system}; this check needs a Linux host`);
            }
            return `ssh ${options.ssh} answered: ${git}; ${system}`;
        });
        if (!reached) {
            this.plan.skipRest(`the SSH preflight on ${options.ssh} failed`);
            return;
        }
        let remote;
        const clone = await this.cloneStep(host, async () => {
            remote = await this.remoteScratch(host);
            return remote.dir;
        });
        if (!clone) {
            this.plan.skipRest('the clone step failed');
            return;
        }
        const suiteDir = path.posix.join(remote.dir, 'suite');
        const stubDir = path.posix.join(remote.dir, 'stub');
        const staged = await this.plan.run('stage', async () => {
            await this.stage(host, suiteDir, stubDir, this.suiteConfig('provision', clone));
            if (remote.ownsServer) {
                const made = await runCommands(host, { mkdir: `mkdir -p ${shellQuote(remote.installPath)}` });
                output(made, 'mkdir', `mkdir -p ${remote.installPath}`);
            }
            return `${SUITE_FILE}, ${CONFIG_FILE}, and an inert development extension, copied over ssh to`
                + ` ${remote.dir}; the VS Code Server's install path is ${remote.installPath}`;
        });
        if (!staged) {
            this.plan.skip(['remote-ssh', 'server', 'install', 'launch', ...SUITE_IDS], 'the suite is not on the host');
            await this.afterStep(host, clone);
            return;
        }

        const profile = profilePaths(this.scratch);
        const settings = this.settings({ alias: options.ssh, configFile, installPath: remote.installPath });
        const uri = file => `vscode-remote://ssh-remote+${options.ssh}`
            + file.split('/').map(encodeURIComponent).join('/');
        // Assumes VS Code accepts vscode-remote URIs for the development extension and the test runner, which then
        // run in the remote extension host.
        const args = [`--folder-uri=${uri(clone.dir)}`, ...profile.args, ...TEST_FLAGS,
            `--extensionDevelopmentPath=${uri(stubDir)}`,
            `--extensionTestsPath=${uri(path.posix.join(suiteDir, SUITE_FILE))}`];
        const remoteVsix = path.posix.join(remote.dir, path.basename(pkg.file));
        this.describeSshRun({ settings, profile, editor, args, remote, remoteVsix });
        if (options.dryRun) {
            this.plan.skip(['remote-ssh', 'server', 'install', 'launch', ...SUITE_IDS],
                'dry run: this step needs the VS Code Server and Remote - SSH licenses accepted');
            await this.afterStep(host, clone, { dryRun: true });
            this.report.note('Dry run: Remote - SSH was not installed, no VS Code Server was downloaded, and no window'
                + ' opened. The settings and commands the real run uses are attached.');
            return;
        }

        const installed = await this.plan.run('remote-ssh', async () => {
            await writeSettings(profile, settings);
            return `the VS Code CLI installed ${REMOTE_SSH} into the test profile`
                + ` ("${await this.installInProfile(editor, profile, REMOTE_SSH)}"); settings written`;
        });
        let facts;
        if (installed) {
            await this.plan.run('server', async () => {
                const launch = await this.launch(editor, args, 'vscode-provision.log', PROVISION_TIMEOUT_MS);
                const read = await readResults(host, suiteDir);
                const problem = launchProblem(launch, read, 'provision')
                    ?? (read.results.host?.remoteName === 'ssh-remote' ? undefined
                        : `the suite ran in a ${read.results.host?.remoteName ?? 'local'} extension host`);
                if (problem) {
                    this.attachTail(launch);
                    throw new Error(problem);
                }
                facts = read.results.host;
                return `Remote - SSH brought up VS Code Server ${facts.vscodeVersion} at ${facts.appRoot}; its`
                    + ` extension host runs on ${facts.platform} ${facts.arch} with Node ${facts.node}`;
            });
        }
        let folders;
        if (facts) {
            await this.plan.run('install', async () => {
                const found = serverFolders(facts.server, remote.installPath);
                // Installing anywhere else could change a VS Code Server that other windows use.
                if (!found.extensions.startsWith(`${remote.installPath}/`)) {
                    throw new Error(`the server's extensions folder ${found.extensions} is outside the install path`
                        + ` ${remote.installPath}`);
                }
                const codeServer = await findCodeServer(host, remote.installPath, facts);
                await host.writeFile(remoteVsix, await readFile(pkg.file));
                const result = await runCommands(host, {
                    install: serverInstallCommand(codeServer, remoteVsix, found.extensions),
                }, { timeoutMs: 300_000 });
                const said = lastLines(output(result, 'install', `${codeServer} --install-extension`), 1);
                if (remote.ownsServer) {
                    // Assumes a freshly started server finds the new extension, where a running one might keep a
                    // cached scan; with --server-install-path the server is not this run's to stop.
                    await this.stopServer(host, remote);
                }
                folders = found;
                return `${codeServer} --install-extension: "${said}"; extensions folder ${found.extensions}`;
            });
        }
        if (folders) {
            await this.writeConfig(host, suiteDir, this.suiteConfig('check', clone, folders.extensions));
            const launch = await this.launch(editor, args, 'vscode.log', LAUNCH_TIMEOUT_MS);
            this.recordSuite(launch, await readResults(host, suiteDir), editor,
                `the remote extension host on ${options.ssh}`, true);
        } else {
            const reason = !installed ? 'Remote - SSH is not installed'
                : !facts ? 'there is no VS Code Server' : 'the package is not on the server';
            this.plan.skip(['server', 'install', 'launch', ...SUITE_IDS], reason);
        }
        if (remote.ownsServer) {
            // Before the after check, so that no extension host is left working in the clone.
            await this.stopServer(host, remote).catch(error => this.report.note(errorText(error)));
        }
        await this.afterStep(host, clone);
        await this.attachLog(host, serverFolders(facts?.server, remote.installPath).data);
    }

    async cloneStep(host, makeParent) {
        let clone;
        await this.plan.run('clone', async () => {
            clone = await prepareClone(host, await makeParent(), this.options);
            this.report.target.Repository = `fresh clone of ${this.options.repoUrl} at ${clone.before.head}`;
            const { before } = clone;
            return `${clone.dir} on ${host.label}, HEAD ${before.head}: check commit present (${clone.commit}, parent`
                + ` ${clone.parent}); no git status output; count: ${before.counts.count}, in-pack:`
                + ` ${before.counts['in-pack']}; ${before.refs.length} refs; ${PATCH}: ${clone.files.length} files`
                + ` (${clone.files.join(', ')}); ${SECOND_PATCH}: ${clone.secondFiles.join(', ')}`;
        });
        return clone;
    }

    async remoteScratch(host) {
        const made = await runCommands(host, { dir: 'mktemp -d "${TMPDIR:-/tmp}/view-patch-check-a.XXXXXXXX"' });
        const dir = output(made, 'dir', 'mktemp -d').trim();
        if (!dir.startsWith('/')) {
            throw new Error(`mktemp -d printed ${dir}`);
        }
        const remote = {
            dir,
            installPath: this.options.installPath ?? path.posix.join(dir, 'server'),
            ownsServer: !this.options.installPath,
        };
        this.cleanup.add(`the scratch folder on ${host.label}`, () => {
            const result = host.shSync(this.remoteCleanupScript(remote), 60_000);
            if (result.status !== 0) {
                throw new Error(lastLines(result.stderr) || `exit code ${result.status}`);
            }
        }, async () => {
            const result = await host.sh(this.remoteCleanupScript(remote), { timeoutMs: 120_000 });
            if (result.status !== 0) {
                throw new Error(lastLines(result.stderr) || `exit code ${result.status}`);
            }
        });
        return remote;
    }

    remoteCleanupScript(remote) {
        // Everything under the scratch folder is this run's, including a VS Code Server in the default install path
        // and a command that an interrupt left running there.
        const script = [stopProcessesScript(remote.dir)];
        if (this.options.keep) {
            this.report.note(`Kept the scratch folder ${remote.dir} on ${this.options.ssh}.`);
            console.log(`Kept ${this.options.ssh}:${remote.dir}`);
        } else {
            script.push(`rm -rf ${shellQuote(remote.dir)}`);
        }
        return `${script.join('\n')}\n`;
    }

    async stopServer(host, remote) {
        // Assumes every VS Code Server process names its install folder in its command line, as the server's node
        // binary and scripts live there.
        const result = await host.sh(stopProcessesScript(remote.installPath), { timeoutMs: 60_000 });
        if (result.status !== 0) {
            throw new Error(`stopping the VS Code Server failed: ${lastLines(result.stderr) || result.status}`);
        }
    }

    keepOrRemove(dir) {
        if (this.options.keep) {
            this.report.note(`Kept the scratch folder ${dir}.`);
            console.log(`Kept ${dir}`);
        } else {
            // Windows can briefly keep profile files open after the editor exits.
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    }

    settings(ssh) {
        const settings = {
            'extensions.autoCheckUpdates': false,
            'extensions.autoUpdate': false,
            'update.mode': 'none',
            'telemetry.telemetryLevel': 'off',
            'workbench.startupEditor': 'none',
            'workbench.welcomePage.walkthroughs.openOnInstall': false,
            'chat.disableAIFeatures': true,
            'git.autofetch': false,
            'security.workspace.trust.enabled': false,
        };
        if (ssh) {
            // Assumes Remote - SSH reads these settings, and with remote.SSH.configFile runs ssh -F with that file.
            if (ssh.configFile) {
                settings['remote.SSH.configFile'] = ssh.configFile;
            }
            Object.assign(settings, {
                'remote.SSH.remotePlatform': { [ssh.alias]: 'linux' },
                'remote.SSH.serverInstallPath': { [ssh.alias]: ssh.installPath },
                'remote.SSH.showLoginTerminal': false,
                'remote.SSH.connectTimeout': 120,
            });
        }
        return settings;
    }

    suiteConfig(phase, clone, extensionsDir) {
        return {
            schemaVersion: 1,
            phase,
            window: this.options.ssh ? 'ssh-remote' : 'local',
            steps: SUITE_STEPS,
            extensionId: EXTENSION_ID,
            version: this.options.version,
            extensionsDir: extensionsDir ?? null,
            clone: clone.dir,
            base: `${clone.commit}^`,
            patch: path.posix.join(clone.dir, PATCH),
            secondPatch: path.posix.join(clone.dir, SECOND_PATCH),
            files: clone.files,
            secondFiles: clone.secondFiles,
            markFile: clone.files.includes('src/patchText.ts') ? 'src/patchText.ts' : clone.files[0],
            commandTimeoutMs: COMMAND_TIMEOUT_MS,
        };
    }

    async stage(host, suiteDir, stubDir, config) {
        const made = await runCommands(host, { mkdir: `mkdir -p ${shellQuote(suiteDir)} ${shellQuote(stubDir)}` });
        output(made, 'mkdir', `mkdir -p ${suiteDir} ${stubDir}`);
        await host.writeFile(path.posix.join(suiteDir, SUITE_FILE), await readFile(path.join(here, SUITE_FILE)));
        await host.writeFile(path.posix.join(stubDir, 'package.json'), STUB);
        await this.writeConfig(host, suiteDir, config);
    }

    /** Writes the suite's configuration and removes results of an earlier phase. */
    async writeConfig(host, suiteDir, config) {
        const removed = await runCommands(host, {
            remove: `rm -f ${shellQuote(path.posix.join(suiteDir, RESULTS_FILE))}`,
        });
        output(removed, 'remove', `removing the earlier ${RESULTS_FILE}`);
        await host.writeFile(path.posix.join(suiteDir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    }

    /**
     * The environment for VS Code and its CLI. In local mode, VS Code and its extensions get a temporary folder
     * inside the scratch folder, so the caches they leave there, such as node-compile-cache and
     * vscode-typescript<uid>, go with it. Without XDG_RUNTIME_DIR, or on macOS, VS Code also puts IPC sockets there,
     * whose paths must stay short. SSH mode, which has not run yet, keeps the usual temporary folder.
     */
    async vscodeEnv() {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const tmp = path.join(this.scratch, 'tmp');
        const socket = path.join(tmp, `vscode-ipc-${'0'.repeat(36)}.sock`);
        const shortEnough = (process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR) || socket.length < 100;
        if (!this.options.ssh && shortEnough) {
            await mkdir(tmp, { recursive: true });
            env.TMPDIR = tmp;
        }
        return env;
    }

    async installInProfile(editor, profile, extension) {
        await mkdir(profile.extensions, { recursive: true });
        // Windows runs the CLI's .cmd file through a shell, which needs each argument quoted.
        const quote = value => (windows ? `"${value}"` : value);
        const result = await run(quote(editor.cli), [...profile.args, '--install-extension', extension].map(quote),
            { timeoutMs: 300_000, env: await this.vscodeEnv(), shell: windows });
        if (result.status !== 0) {
            throw new Error(`the VS Code CLI could not install ${extension} (exit code ${result.status}):`
                + ` ${lastLines(result.stderr || result.stdout)}`);
        }
        return lastLines(result.stdout, 1);
    }

    async launch(editor, args, logName, timeoutMs) {
        await mkdir(this.options.out, { recursive: true });
        const log = path.join(this.options.out, logName);
        const file = createWriteStream(log);
        const env = await this.vscodeEnv();
        const started = Date.now();
        console.log(`Launching VS Code ${editor.version}; its output also goes to ${log}`);
        const outcome = await new Promise(resolve => {
            // A process group of its own, so that a timeout or an interrupt can stop every process it started;
            // Windows has none, and killTree() stops the process tree there instead.
            const child = spawn(editor.executable, args, {
                detached: !windows,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const stop = () => killTree(child.pid);
            const task = this.cleanup.add('VS Code', stop);
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                stop();
            }, timeoutMs);
            for (const stream of [child.stdout, child.stderr]) {
                stream.on('data', chunk => {
                    file.write(chunk);
                    process.stdout.write(chunk);
                });
            }
            const finish = result => {
                clearTimeout(timer);
                this.cleanup.remove(task);
                resolve(result);
            };
            child.on('error', error => finish({ error: errorText(error) }));
            child.on('exit', () => {
                // Stops any helper left in its process group, which could otherwise keep the output pipes open.
                stop();
                setTimeout(() => {
                    child.stdout.destroy();
                    child.stderr.destroy();
                }, 10_000).unref();
            });
            child.on('close', (code, signal) => finish({ code, signal, timedOut }));
        });
        await new Promise(resolve => file.end(resolve));
        return { ...outcome, seconds: Math.round((Date.now() - started) / 1000), log, timeoutMs };
    }

    /** Records the test window's launch, then the steps that the suite recorded. */
    recordSuite(launch, read, editor, where, remote = false) {
        const { results } = read;
        let problem = launchProblem(launch, read, 'check');
        if (!problem && remote && results.host?.remoteName !== 'ssh-remote') {
            problem = `the suite ran in a ${results.host?.remoteName ?? 'local'} extension host, not ssh-remote`;
        }
        if (problem) {
            this.plan.record('launch', 'fail', problem);
            this.attachTail(launch);
        } else {
            this.plan.record('launch', 'pass', `VS Code ${editor.version} opened the clone and ran the steps in`
                + ` ${where}; it exited with code 0 after ${launch.seconds} s`);
        }
        for (const step of results?.phase === 'check' ? results.steps ?? [] : []) {
            this.plan.record(step.id, step.status, step.detail, step.name);
        }
        this.plan.skip(SUITE_IDS, results?.error ? `the suite stopped: ${results.error}`
            : problem ?? 'the suite did not record this step');
        for (const note of results?.notes ?? []) {
            this.report.note(note);
        }
        for (const { label, text } of results?.evidence ?? []) {
            this.report.attach(label, text);
        }
    }

    attachTail(launch) {
        if (launch.log && existsSync(launch.log)) {
            const text = readFileSync(launch.log, 'utf8').split('\n').slice(-80).join('\n');
            this.report.attach(`VS Code output, the end of ${launch.log}`, text);
        }
    }

    async afterStep(host, clone, { dryRun = false } = {}) {
        await this.plan.run('after', async () => {
            const removed = await runCommands(host, { remove: `rm -f ${PATCH} ${SECOND_PATCH}` }, { cwd: clone.dir });
            output(removed, 'remove', 'removing the patches');
            const { before } = clone;
            const after = await gitState(host, clone.dir);
            const problems = [];
            if (after.status) {
                problems.push(`git status --short shows ${oneLine(after.status)}`);
            }
            for (const key of ['count', 'in-pack']) {
                if (after.counts[key] !== before.counts[key]) {
                    problems.push(`${key} went from ${before.counts[key]} to ${after.counts[key]}`);
                }
            }
            if (after.head !== before.head) {
                problems.push(`HEAD moved from ${before.head} to ${after.head}`);
            }
            const refs = listChanges(before.refs, after.refs);
            if (refs) {
                problems.push(`the refs changed: ${refs}`);
            }
            const other = otherGitChanges(before, after);
            if (other) {
                this.report.note(other);
            }
            if (problems.length > 0) {
                throw new Error(problems.join('; '));
            }
            return `${dryRun ? 'dry run, so no review ran since the preflight: ' : ''}removed both patches; no git`
                + ` status output; count: ${after.counts.count}, in-pack: ${after.counts['in-pack']}, as before;`
                + ` HEAD and the ${after.refs.length} refs unchanged`;
        });
    }

    /** Attaches View Patch's log from under `dir` on the host, and notes any error it logged. */
    async attachLog(host, dir) {
        try {
            const found = await runCommands(host, {
                log: `find ${shellQuote(dir)} -type f -name 'View Patch.log' -path '*/${EXTENSION_ID}/*'`
                    + ' -exec ls -t {} +',
            });
            const file = lines(found.log.out)[0];
            if (!file) {
                this.report.note(`View Patch's log was not found under ${dir} on ${host.label}.`);
                return;
            }
            const read = await runCommands(host, { text: `cat ${shellQuote(file)}` });
            const text = output(read, 'text', `cat ${file}`);
            this.report.attach(`View Patch log (${file} on ${host.label})`, text);
            const errors = lines(text).filter(line => line.includes(' [error] '));
            if (errors.length > 0) {
                this.report.note(`View Patch logged ${errors.length} errors: ${oneLine(errors.join(' / '))}`);
            }
        } catch (error) {
            this.report.note(`View Patch's log could not be read: ${errorText(error)}`);
        }
    }

    describeSshRun({ settings, profile, editor, args, remote, remoteVsix }) {
        const { extensions } = serverFolders(undefined, remote.installPath);
        const text = [
            `Settings, written to ${path.join(profile.user, 'User', 'settings.json')}:`,
            JSON.stringify(settings, null, 4),
            '',
            'Remote - SSH, installed into the test profile:',
            formatCommand([editor.cli, ...profile.args, '--install-extension', REMOTE_SSH]),
            '',
            'VS Code, launched twice with these arguments: first with the suite in its provision phase, which brings'
                + ` up the VS Code Server under ${remote.installPath}; then, after the package is installed there, to`
                + ' run the steps:',
            formatCommand([editor.executable, ...args]),
            '',
            `Between the launches, on ${this.options.ssh} through ssh, with the bin/code-server found under the`
                + ' install path and the extensions folder that the server\'s command line names (default shown):',
            serverInstallCommand('<server>/bin/code-server', remoteVsix, extensions),
        ].join('\n');
        console.log(`\n${text}\n`);
        this.report.attach(this.options.dryRun ? 'What the real run would use' : 'Settings and commands of this run',
            text);
    }
}

function parseOptions(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
            version: { type: 'string' },
            channel: { type: 'string', default: 'regular' },
            vsix: { type: 'string' },
            vscode: { type: 'string', default: process.env.VSCODE_TEST_VERSION || 'stable' },
            out: { type: 'string', default: path.join('.release-checks', 'check-a') },
            'repo-url': { type: 'string', default: 'https://github.com/waddahmoghram/vscode-view-patch.git' },
            commit: { type: 'string', default: 'eabcdbec06950075f15d24526eb1b7041c7e886d' },
            'second-commit': { type: 'string', default: 'f9ce6f0893058f4d804e423ed020efcd578a6604' },
            keep: { type: 'boolean', default: false },
            ssh: { type: 'string' },
            'ssh-config': { type: 'string' },
            'server-install-path': { type: 'string' },
            'local-sshd': { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            'accept-server-license': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        return { help: true };
    }
    if (!/^\d+\.\d+\.\d+$/.test(values.version ?? '')) {
        throw new Error('--version <x.y.z> is required.');
    }
    if (!['regular', 'pre-release'].includes(values.channel)) {
        throw new Error('--channel must be regular or pre-release.');
    }
    for (const name of ['commit', 'second-commit']) {
        if (!/^[0-9a-f]{7,40}$/i.test(values[name])) {
            throw new Error(`--${name} must be a commit hash.`);
        }
    }
    for (const name of ['vscode', 'out', 'repo-url']) {
        if (!values[name]) {
            throw new Error(`--${name} needs a value.`);
        }
    }
    const vsix = values.vsix && path.resolve(values.vsix);
    if (vsix && !existsSync(vsix)) {
        throw new Error(`There is no package at ${vsix}.`);
    }
    let ssh = values.ssh;
    if (values['local-sshd']) {
        if (ssh && ssh !== LOCAL_SSH_ALIAS) {
            throw new Error(`--local-sshd uses the alias ${LOCAL_SSH_ALIAS}, not ${ssh}.`);
        }
        if (values['ssh-config']) {
            throw new Error('--local-sshd writes its own ssh configuration, so it takes no --ssh-config.');
        }
        ssh = LOCAL_SSH_ALIAS;
    }
    if (!ssh) {
        const sshOnly = ['ssh-config', 'server-install-path', 'dry-run', 'accept-server-license'];
        const given = sshOnly.find(name => values[name]);
        if (given) {
            throw new Error(`--${given} needs --ssh <alias>.`);
        }
    } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(ssh)) {
        // A Remote - SSH folder URI carries the alias as its authority, which VS Code compares in lowercase.
        throw new Error('--ssh takes an ssh host alias of lowercase letters, digits, dots, underscores, and hyphens.');
    }
    const sshConfig = values['ssh-config'] && path.resolve(values['ssh-config']);
    if (sshConfig && !existsSync(sshConfig)) {
        throw new Error(`There is no ssh configuration at ${sshConfig}.`);
    }
    const installPath = values['server-install-path']
        && path.posix.normalize(values['server-install-path']).replace(/(.)\/+$/, '$1');
    if (installPath !== undefined && (!path.posix.isAbsolute(installPath) || installPath === '/')) {
        throw new Error('--server-install-path must be an absolute folder on the remote host, other than /.');
    }
    return {
        version: values.version,
        channel: values.channel,
        vsix,
        vscode: values.vscode,
        out: path.resolve(values.out),
        repoUrl: values['repo-url'],
        commit: values.commit,
        secondCommit: values['second-commit'],
        keep: values.keep,
        ssh,
        sshConfig,
        installPath,
        localSshd: values['local-sshd'],
        dryRun: values['dry-run'],
        acceptLicense: values['accept-server-license'],
    };
}

async function downloadPackage(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
        throw new Error(`the Marketplace answered ${response.status} ${response.statusText} for ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    // fetch() decodes a Content-Encoding: gzip response itself; a gzip body without that header still needs it.
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

/** Clones the repository into `parent` on the host, checks it as section 6 does, and writes both patches. */
async function prepareClone(host, parent, { repoUrl, commit, secondCommit }) {
    const dir = path.posix.join(parent, 'vp-check-a');
    // Git asks for credentials on the terminal itself, which an unattended run must not wait for.
    const cloned = await runCommands(host, {
        clone: `GIT_TERMINAL_PROMPT=0 git clone --quiet ${shellQuote(repoUrl)} ${shellQuote(dir)}`,
    }, { timeoutMs: 600_000 });
    output(cloned, 'clone', `git clone ${repoUrl}`);
    const found = await runCommands(host, {
        commit: `git rev-parse --verify --quiet ${shellQuote(`${commit}^{commit}`)}`,
        second: `git rev-parse --verify --quiet ${shellQuote(`${secondCommit}^{commit}`)}`,
    }, { cwd: dir });
    if (found.commit.status !== 0 || found.second.status !== 0) {
        throw new Error(`commit ${found.commit.status !== 0 ? commit : secondCommit} is not in the clone`);
    }
    const before = await gitState(host, dir);
    if (before.status) {
        throw new Error(`git status --short shows ${oneLine(before.status)}`);
    }
    const full = found.commit.out.trim();
    const fullSecond = found.second.out.trim();
    const made = await runCommands(host, {
        patch: `git format-patch -1 ${full} --stdout > ${PATCH}`,
        second: `git format-patch -1 ${fullSecond} --stdout > ${SECOND_PATCH}`,
        parent: `git rev-parse ${full}^`,
        files: `git diff-tree --no-commit-id --name-only -r ${full}`,
        secondFiles: `git diff-tree --no-commit-id --name-only -r ${fullSecond}`,
    }, { cwd: dir });
    for (const name of ['patch', 'second', 'parent', 'files', 'secondFiles']) {
        output(made, name, `writing the patches (${name})`);
    }
    return {
        dir,
        commit: full,
        secondCommit: fullSecond,
        parent: made.parent.out.trim(),
        files: lines(made.files.out),
        secondFiles: lines(made.secondFiles.out),
        before,
    };
}

const GIT_STATE = {
    // --no-optional-locks keeps git status from refreshing the index, which would show up as a .git change.
    status: 'git --no-optional-locks status --short',
    counts: 'git count-objects -v',
    head: 'git rev-parse HEAD',
    refs: 'git for-each-ref --format=\'%(objectname) %(refname)\'',
    files: 'find .git -type f -exec cksum {} +',
    config: 'cat .git/config',
};

/** What the after check compares: the status, object counts, HEAD, refs, and a checksum of each file under .git. */
async function gitState(host, dir) {
    const state = await runCommands(host, GIT_STATE, { cwd: dir });
    for (const [name, command] of Object.entries(GIT_STATE)) {
        output(state, name, command);
    }
    return {
        status: state.status.out.trim(),
        counts: Object.fromEntries(lines(state.counts.out).map(line => line.split(/:\s*/))),
        head: state.head.out.trim(),
        refs: lines(state.refs.out),
        files: new Map(lines(state.files.out).map(line => {
            const [sum, size, ...name] = line.split(' ');
            return [name.join(' '), `${sum} ${size}`];
        })),
        config: state.config.out,
    };
}

function otherGitChanges(before, after) {
    const changed = [];
    for (const [file, sum] of after.files) {
        if (!before.files.has(file)) {
            changed.push(`${file} (new)`);
        } else if (before.files.get(file) !== sum) {
            changed.push(file === '.git/config' ? `.git/config (${configChange(before.config, after.config)})` : file);
        }
    }
    for (const file of before.files.keys()) {
        if (!after.files.has(file)) {
            changed.push(`${file} (removed)`);
        }
    }
    if (changed.length === 0) {
        return '';
    }
    const shown = changed.length > 12 ? [...changed.slice(0, 12), `${changed.length - 12} more`] : changed;
    return `Other changes under .git, noted rather than failed because VS Code's Git extension writes some:`
        + ` ${shown.join(', ')}.`;
}

function configChange(before, after) {
    const old = lines(before).map(line => line.trim());
    const now = lines(after).map(line => line.trim());
    return [
        ...now.filter(line => !old.includes(line)).map(line => `added ${line}`),
        ...old.filter(line => !now.includes(line)).map(line => `removed ${line}`),
    ].join('; ') || 'rewritten';
}

function listChanges(before, after) {
    return [
        ...before.filter(line => !after.includes(line)).map(line => `- ${line}`),
        ...after.filter(line => !before.includes(line)).map(line => `+ ${line}`),
    ].join(', ');
}

/**
 * Stops every process whose command line contains `dir`, such as a VS Code Server installed there, and every process
 * they started, which may not name `dir`, as git clone's helpers do not.
 */
function stopProcessesScript(dir) {
    // The script arrives on standard input, so the shells that run it do not have `dir` in their command lines.
    return [
        'found=$(ps -ww -eo pid=,args= | while read -r pid args; do',
        `    case "$args" in *${shellQuote(dir)}*) echo "$pid" ;; esac`,
        'done)',
        'pids=$found',
        'for level in 1 2 3 4 5 6 7 8; do',
        '    parents=" $(echo $found) "',
        '    found=$(ps -eo pid=,ppid= | while read -r pid ppid; do',
        '        case "$parents" in *" $ppid "*) echo "$pid" ;; esac',
        '    done)',
        '    [ -n "$found" ] || break',
        '    pids="$pids $found"',
        'done',
        'if [ -n "$(echo $pids)" ]; then',
        '    kill $pids 2>/dev/null',
        '    sleep 2',
        '    kill -9 $pids 2>/dev/null',
        'fi',
        'true',
    ].join('\n');
}

/**
 * Where the VS Code Server keeps its data and extensions. Assumes the server's own order: --extensions-dir, else the
 * data folder's extensions, where the data folder is --server-data-dir, else, as Remote - SSH sets it up for a
 * serverInstallPath, <install path>/.vscode-server.
 */
function serverFolders(server, installPath) {
    const data = server?.serverDataDir ?? path.posix.join(installPath, '.vscode-server');
    return { data, extensions: server?.extensionsDir ?? path.posix.join(data, 'extensions') };
}

/**
 * Finds the server's bin/code-server under the install path, preferring the app root its extension host reported.
 * Assumes the layout <server folder>/bin/code-server, where the server folder is the remote extension host's app root.
 */
async function findCodeServer(host, installPath, facts) {
    const found = await runCommands(host, {
        list: `find ${shellQuote(installPath)} -type f -path '*/bin/code-server'`,
    });
    const candidates = lines(found.list.out);
    const reported = facts.appRoot && path.posix.join(facts.appRoot, 'bin', 'code-server');
    const chosen = candidates.find(file => file === reported) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!chosen) {
        throw new Error(`${installPath} holds ${candidates.length} bin/code-server files, and none is in the server's`
            + ` app root ${facts.appRoot}`);
    }
    return chosen;
}

function serverInstallCommand(codeServer, vsix, extensions) {
    return `${shellQuote(codeServer)} --install-extension ${shellQuote(vsix)} --extensions-dir`
        + ` ${shellQuote(extensions)} --force`;
}

async function readResults(host, suiteDir) {
    try {
        const read = await runCommands(host, { results: `cat ${shellQuote(path.posix.join(suiteDir, RESULTS_FILE))}` });
        if (read.results.status !== 0) {
            return { error: `the suite wrote no ${RESULTS_FILE}` };
        }
        return { results: JSON.parse(read.results.out) };
    } catch (error) {
        return { error: `its results could not be read: ${errorText(error)}` };
    }
}

function launchProblem(launch, { results, error }, phase) {
    const exit = launch.signal ? `signal ${launch.signal}` : `code ${launch.code}`;
    if (launch.error) {
        return `VS Code did not start: ${launch.error}`;
    }
    if (launch.timedOut) {
        return `VS Code had not finished after ${launch.timeoutMs / 60_000} minutes, so it was stopped`;
    }
    if (!results) {
        return `VS Code exited with ${exit}, and ${error}`;
    }
    if (results.phase !== phase) {
        return `the suite's results are from its ${results.phase} phase, not ${phase}`;
    }
    if (results.error) {
        return `the suite stopped with an error: ${results.error}`;
    }
    if (launch.code !== 0) {
        return `VS Code exited with ${exit}`;
    }
    return undefined;
}

function profilePaths(scratch) {
    const extensions = path.join(scratch, 'profile', 'extensions');
    const user = path.join(scratch, 'profile', 'user');
    return { extensions, user, args: [`--extensions-dir=${extensions}`, `--user-data-dir=${user}`] };
}

async function writeSettings(profile, settings) {
    await mkdir(path.join(profile.user, 'User'), { recursive: true });
    await writeFile(path.join(profile.user, 'User', 'settings.json'), `${JSON.stringify(settings, null, 4)}\n`);
}

/** A command line to read and to paste into a shell, with one option and its value per line. */
function formatCommand(argv) {
    const quote = arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg));
    const parts = [];
    for (const arg of argv) {
        if (/^--[\w-]+$/.test(parts.at(-1) ?? '') && !arg.startsWith('-')) {
            parts.push(`${parts.pop()} ${quote(arg)}`);
        } else {
            parts.push(quote(arg));
        }
    }
    return parts.join(' \\\n    ');
}

/** A section's standard output; throws when its command failed. */
function output(sections, name, what) {
    const section = sections[name];
    if (section.status !== 0) {
        throw new Error(`${what} failed with exit code ${section.status}: ${lastLines(sections.stderr) || 'no error'}`);
    }
    return section.out;
}

function lines(text) {
    return String(text ?? '').split('\n').map(line => line.trimEnd()).filter(Boolean);
}

function oneLine(text) {
    return lines(text).join(' / ');
}

async function main(argv) {
    let options;
    try {
        options = parseOptions(argv);
    } catch (error) {
        console.error(`${errorText(error)}\n\n${USAGE}`);
        return EXIT.usage;
    }
    if (options.help) {
        console.log(USAGE);
        return EXIT.pass;
    }
    if (options.ssh && !options.dryRun && !options.acceptLicense) {
        console.error(LICENSE);
        return EXIT.usage;
    }
    const opensWindow = !options.ssh || !options.dryRun;
    if (opensWindow && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        console.error('VS Code needs a display: run this under xvfb-run -a.');
        return EXIT.usage;
    }
    return new CheckA(options).run();
}

process.exitCode = await main(process.argv.slice(2));
