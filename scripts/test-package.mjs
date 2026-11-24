import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { readVSIXPackage } from '@vscode/vsce/out/zip.js';

// Installs a built package into a fresh extensions folder, then runs src/test/package against that installed copy.
//
//   node scripts/test-package.mjs [path/to/view-patch.vsix]    defaults to ./view-patch.vsix
//
// VS Code requires a development extension to run tests, so an inert stub stands in for one; the repository itself
// is never loaded as an extension. VSCODE_TEST_VERSION picks the VS Code release, as for the other layers.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suite = path.join(root, 'out', 'test', 'package', 'index.js');
const windows = process.platform === 'win32';

async function main(args) {
    if (args.length > 1) {
        console.error('Usage: node scripts/test-package.mjs [path/to/view-patch.vsix]');
        return 2;
    }
    const vsix = path.resolve(args[0] ?? 'view-patch.vsix');
    if (!existsSync(vsix)) {
        console.error(`No package at ${vsix}. Build one with: npx vsce package --out ${vsix}`);
        return 2;
    }
    if (!existsSync(suite)) {
        console.error(`${suite} is missing. Run npm run compile first.`);
        return 2;
    }
    const { manifest } = await readVSIXPackage(vsix);
    const digest = createHash('sha256').update(await readFile(vsix)).digest('hex');
    const executable = await downloadAndUnzipVSCode({
        version: process.env.VSCODE_TEST_VERSION || 'stable',
        cachePath: path.join(root, '.vscode-test'),
    });
    console.log(`Smoke-testing ${vsix}: ${manifest.publisher}.${manifest.name} ${manifest.version}, SHA-256 ${digest}`);

    const scratch = await mkdtemp(path.join(tmpdir(), 'view-patch-package-'));
    try {
        const extensions = path.join(scratch, 'extensions');
        const user = path.join(scratch, 'user');
        const stub = path.join(scratch, 'stub');
        await mkdir(path.join(user, 'User'), { recursive: true });
        await mkdir(stub);
        await writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
            'extensions.autoCheckUpdates': false,
            'extensions.autoUpdate': false,
            'telemetry.telemetryLevel': 'off',
            'workbench.startupEditor': 'none',
            'chat.disableAIFeatures': true,
        }));
        await writeFile(path.join(stub, 'package.json'), JSON.stringify({
            name: 'package-smoke-stub',
            publisher: 'view-patch-tests',
            version: '0.0.0',
            engines: { vscode: '*' },
        }));
        const profile = [`--extensions-dir=${extensions}`, `--user-data-dir=${user}`];

        // The helper also returns arguments for the shared .vscode-test profile; this run uses its own instead.
        const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
        // Windows runs the CLI's .cmd file through a shell, which needs each argument quoted.
        const quote = value => (windows ? `"${value}"` : value);
        const install = spawnSync(quote(cli), [...profile, '--install-extension', vsix].map(quote), {
            stdio: 'inherit',
            shell: windows,
        });
        if (install.status !== 0) {
            console.error(`Installing ${vsix} failed: ${install.error?.message ?? `exit code ${install.status}`}.`);
            return 1;
        }

        await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: stub,
            extensionTestsPath: suite,
            launchArgs: profile,
            extensionTestsEnv: {
                VIEW_PATCH_EXPECTED_VERSION: manifest.version,
                VIEW_PATCH_EXTENSIONS_DIR: extensions,
            },
        });
        return 0;
    } catch (error) {
        console.error(`Installed-package tests failed: ${error instanceof Error ? error.message : error}`);
        return 1;
    } finally {
        // Windows can briefly keep profile files open after the editor exits.
        await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

process.exitCode = await main(process.argv.slice(2));
