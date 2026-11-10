import { defineConfig } from '@vscode/test-cli';

// VSCODE_TEST_VERSION picks the VS Code release to test against; CI also runs the oldest one package.json allows.
export default defineConfig({
    files: 'out/test/integration/**/*.test.js',
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    mocha: {
        ui: 'tdd',
        timeout: 60000,
    },
});
