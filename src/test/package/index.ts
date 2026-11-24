import { readdirSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

// The Mocha that @vscode/test-cli brings for the editor layer.
const Mocha: typeof import('mocha') = createRequire(require.resolve('@vscode/test-cli'))('mocha');

/** Entry point that scripts/test-package.mjs passes to VS Code as the extension tests path. */
export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', timeout: 60_000 });
    for (const name of readdirSync(__dirname, { recursive: true, encoding: 'utf8' }).sort()) {
        if (name.endsWith('.test.js')) {
            mocha.addFile(path.join(__dirname, name));
        }
    }
    return new Promise((resolve, reject) => mocha.run(failures => failures > 0
        ? reject(new Error(`${failures} installed-package ${failures === 1 ? 'test' : 'tests'} failed.`))
        : resolve()));
}
