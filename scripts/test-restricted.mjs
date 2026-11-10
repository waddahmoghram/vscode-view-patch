import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

// The standard test runner always disables workspace trust. This isolated launch tests real Restricted Mode.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = await mkdtemp(path.join(tmpdir(), 'view-patch-restricted-'));
let child;
let timer;
try {
    const workspace = path.join(profile, 'untrusted workspace');
    const user = path.join(profile, 'user');
    await mkdir(workspace);
    await mkdir(path.join(user, 'User'), { recursive: true });
    await writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': true,
        'security.workspace.trust.startupPrompt': 'never',
        'security.workspace.trust.emptyWindow': false,
        'git.enabled': false,
        'git.path': path.join(profile, 'no-git-here'),
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
        'chat.disableAIFeatures': true,
    }));
    const executable = await downloadAndUnzipVSCode({ version: process.env.VSCODE_TEST_VERSION || 'stable' });
    const code = await new Promise((resolve, reject) => {
        child = spawn(executable, [
            workspace,
            `--user-data-dir=${user}`,
            `--extensions-dir=${path.join(profile, 'extensions')}`,
            `--extensionDevelopmentPath=${root}`,
            `--extensionTestsPath=${path.join(root, 'out', 'test', 'restricted', 'run.js')}`,
            '--disable-extensions',
            '--disable-updates',
            '--skip-welcome',
            '--skip-release-notes',
            '--no-sandbox',
            '--disable-gpu-sandbox',
        ], { cwd: root, stdio: 'inherit', env: { ...process.env, VIEW_PATCH_RESTRICTED_ROOT: profile } });
        child.once('error', reject);
        child.once('close', (status, signal) => {
            clearTimeout(timer);
            if (signal) {
                reject(new Error(`Restricted-workspace tests stopped by ${signal}.`));
            } else {
                resolve(status ?? 1);
            }
        });
        timer = setTimeout(() => {
            console.error('Restricted-workspace tests exceeded 180 seconds; stopping the editor.');
            child.kill('SIGKILL');
        }, 180_000);
    });
    process.exitCode = Number(code);
} finally {
    clearTimeout(timer);
    await rm(profile, { recursive: true, force: true });
}
