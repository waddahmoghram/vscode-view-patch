// Bundles the browser-platform test suite that scripts/test-web.mjs runs inside VS Code for
// the Web. The entry is generated inline below: it loads mocha's worker-safe browser build
// (defining the global `mocha`), registers the suites from src/test/web/, and exports the
// `run()` hook the web extension host calls for --extensionTestsPath modules.
//
// It reuses buildOptions() from esbuild.web.mjs (imported, never modified), so the test bundle
// gets the same Node-built-in shims, browser platform, CJS format, and `vscode` external as the
// production web bundle it exercises.
//
// Build:  node esbuild.webtest.mjs    (writes .vscode-test/web/suite.js)
// The output folder is already covered by .gitignore (.vscode-test/) and .vscodeignore
// (.vscode-test/**), so the test bundle can never ship in the vsix or land in Git.

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOptions } from './esbuild.web.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the bundled suite; scripts/test-web.mjs passes this to @vscode/test-web. */
export const testBundle = path.join(root, '.vscode-test', 'web', 'suite.js');

const entry = `
require('mocha/mocha.js'); // UMD browser build; assigns the \`mocha\` global via globalThis

exports.run = function run() {
    return new Promise((resolve, reject) => {
        // \`reporter: undefined\` replaces the browser default (html, which needs a DOM the
        // extension-host worker lacks) with mocha's fallback spec reporter, whose console
        // output @vscode/test-web forwards to the terminal.
        mocha.setup({ ui: 'tdd', reporter: undefined, timeout: 30000 });
        require('./src/test/web/suite.test.ts');
        try {
            mocha.run(failures => failures
                ? reject(new Error(failures + ' web test(s) failed.'))
                : resolve());
        } catch (error) {
            console.error(error);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
};
`;

/** The production web-bundle options with the entry swapped for the generated test entry. */
export function testBuildOptions(overrides = {}) {
    return buildOptions({
        entryPoints: undefined,
        stdin: { contents: entry, resolveDir: root, sourcefile: 'webtest-entry.js', loader: 'js' },
        outfile: testBundle,
        metafile: false,
        logLevel: 'warning',
        ...overrides,
    });
}

async function main() {
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');
    await esbuild.build(testBuildOptions());
    console.log(`Web test bundle written: ${path.relative(root, testBundle)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
