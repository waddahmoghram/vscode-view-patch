import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';

// VSCODE_TEST_VERSION picks the VS Code release to test against; CI also runs the oldest one package.json allows.
const version = process.env.VSCODE_TEST_VERSION || 'stable';
const profile = fileURLToPath(new URL(`.vscode-test/user-data-${version.replace(/[^\w.-]/g, '_')}/`, import.meta.url));

export default defineConfig({
    files: 'out/test/integration/**/*.test.js',
    version,
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${profile}`],
    mocha: {
        ui: 'tdd',
        timeout: 60000,
    },
});
