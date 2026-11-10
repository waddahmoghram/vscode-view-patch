// Runs the browser-platform suite (src/test/web/) inside VS Code for the Web on headless
// chromium, via @vscode/test-web:
//   1. Builds dist/web/extension.js (the production web bundle) if it is missing.
//   2. Builds the test bundle (.vscode-test/web/suite.js) with esbuild.webtest.mjs.
//   3. Launches the web host against this extension and runs the suite; the process exit
//      code reflects the mocha result.
//
// Flags: --quality stable|insiders (default stable), --headed, --verbose, --port <n>.
// The first run downloads the VS Code web build into .vscode-test/web-host/ (network needed);
// chromium comes from the playwright browser cache that installing @vscode/test-web populates.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-web';
import { testBundle } from '../esbuild.webtest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function build(script) {
    const result = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`node ${script} failed with status ${result.status ?? 'unknown'}.`);
    }
}

function flag(name) {
    return process.argv.includes(name);
}

function value(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

try {
    if (!existsSync(path.join(root, 'dist', 'web', 'extension.js'))) {
        build('esbuild.web.mjs');
    }
    build('esbuild.webtest.mjs');
    await runTests({
        browserType: 'chromium',
        headless: !flag('--headed'),
        quality: value('--quality', 'stable') === 'insiders' ? 'insiders' : 'stable',
        port: Number(value('--port', '3000')),
        extensionDevelopmentPath: root,
        extensionTestsPath: testBundle,
        testRunnerDataDir: path.join(root, '.vscode-test', 'web-host'),
        printServerLog: false,
        verbose: flag('--verbose'),
    });
} catch (error) {
    console.error(`test:web failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
