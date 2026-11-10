// Validates the web-bundle groundwork (esbuild.web.mjs + src/browser.ts) against Node's own
// implementations as oracles. Every test skips when the dev-only packages (esbuild, buffer) or
// the bundle config are missing, so this file never breaks `npm test` on a tree that has not
// adopted the web build.
import * as assert from 'node:assert/strict';
import { isUtf8 as nodeIsUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import * as nodePath from 'node:path';
import { test } from 'node:test';
import * as vm from 'node:vm';

interface WebBuildConfig {
    readonly shimSources: Record<string, string>;
    buildOptions(overrides?: object): object;
}

async function optionalImport(name: string): Promise<any | undefined> {
    try {
        return await import(name);
    } catch {
        try {
            // Specifiers like 'buffer/' (the npm package shadowing the built-in) need CommonJS resolution.
            return require(name);
        } catch {
            return undefined;
        }
    }
}

function loadConfig(): Promise<WebBuildConfig | undefined> {
    const configPath = nodePath.join(__dirname, '..', '..', '..', 'esbuild.web.mjs');
    return optionalImport(configPath.startsWith('/') ? `file://${configPath}` : configPath);
}

/** Imports one inline shim, replacing its polyfill import so a data: module can load it. */
async function importShim(config: WebBuildConfig, name: string): Promise<any> {
    const source = config.shimSources[name]
        .replace("import { Buffer as BufferPolyfill } from 'buffer';", 'const BufferPolyfill = globalThis.Buffer;')
        .replace("export { Buffer } from 'buffer';", '');
    return import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
}

test('buffer polyfill behaves like the Node Buffer for every operation the sources use', async t => {
    const polyfill = await optionalImport('buffer/');
    if (!polyfill) {
        return t.skip('the buffer polyfill is not installed');
    }
    const B = polyfill.Buffer;
    assert.notStrictEqual(B, Buffer, 'the polyfill must be its own implementation');
    const sub = B.from('hello world', 'utf8').subarray(0, 5);
    assert.ok(sub instanceof B, 'subarray must stay a polyfill Buffer');
    assert.equal(sub.toString('ascii'), 'hello');
    assert.ok(B.from([0xef, 0xbb, 0xbf]).subarray(0, 3).equals(B.from([0xef, 0xbb, 0xbf])));
    assert.equal(B.from('aGk=', 'base64').toString('utf8'), 'hi');
    assert.equal(B.from('\u00ff', 'latin1')[0], 0xff);
    assert.equal(B.byteLength('h\u00e9llo'), 6);
    assert.equal(B.concat([B.from('a'), B.from('b')], 2).toString('utf8'), 'ab');
    assert.ok(B.from([1, 0, 2]).includes(0));
    assert.equal(B.allocUnsafe(3).length, 3);
    assert.equal(B.alloc(0).length, 0);
    assert.equal(B.from(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2).length, 2);
    assert.equal(B.from('616263', 'hex').toString('utf8'), 'abc');
});

test('sha256 shim matches node:crypto on all block boundaries and a large input', async t => {
    const config = await loadConfig();
    if (!config) {
        return t.skip('esbuild.web.mjs is not present');
    }
    const shim = await importShim(config, 'crypto');
    for (let length = 0; length <= 130; length++) {
        const bytes = randomBytes(length);
        assert.equal(
            shim.createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
            createHash('sha256').update(bytes).digest('hex'),
            `sha256 mismatch at input length ${length}`,
        );
    }
    for (const length of [1000, 65537, 1024 * 1024]) {
        const bytes = randomBytes(length);
        assert.equal(
            shim.createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
            createHash('sha256').update(bytes).digest('hex'),
            `sha256 mismatch at input length ${length}`,
        );
    }
    const incremental = shim.createHash('sha256');
    const parts = [randomBytes(63), randomBytes(2), randomBytes(130)];
    parts.forEach(part => incremental.update(new Uint8Array(part)));
    assert.equal(
        incremental.digest('hex'),
        createHash('sha256').update(Buffer.concat(parts)).digest('hex'),
        'incremental updates must match a single-shot hash',
    );
    assert.throws(() => shim.createHash('sha1'), /sha256/);
    assert.equal(shim.randomBytes(8).length, 8);
});

test('isUtf8 shim matches node:buffer.isUtf8', async t => {
    const config = await loadConfig();
    if (!config) {
        return t.skip('esbuild.web.mjs is not present');
    }
    const shim = await importShim(config, 'node:buffer');
    const cases: Uint8Array[] = [
        new Uint8Array(0),
        new TextEncoder().encode('plain ascii'),
        new TextEncoder().encode('caf\u00e9 \u2014 \u65e5\u672c\u8a9e \u{1f600}'),
        new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), // BOM + ascii
        new Uint8Array([0xc0, 0xaf]), // overlong encoding
        new Uint8Array([0xed, 0xa0, 0x80]), // UTF-16 surrogate half
        new Uint8Array([0xf4, 0x90, 0x80, 0x80]), // above U+10FFFF
        new Uint8Array([0xe2, 0x82]), // truncated multi-byte tail
        new Uint8Array([0x80]), // lone continuation byte
        new Uint8Array([0xff, 0xfe, 0x00, 0x68]), // UTF-16LE BOM bytes
    ];
    for (let index = 0; index < 500; index++) {
        cases.push(new Uint8Array(randomBytes(index % 41)));
    }
    for (const bytes of cases) {
        assert.equal(shim.isUtf8(bytes), nodeIsUtf8(bytes), `isUtf8 mismatch for [${[...bytes].join(',')}]`);
    }
});

test('path shim matches node:path.posix for the calls the sources make', async t => {
    const config = await loadConfig();
    if (!config) {
        return t.skip('esbuild.web.mjs is not present');
    }
    const shim = await importShim(config, 'path');
    const samples = [
        '/repo/sub/file.patch', 'file.patch', '/one/two/', 'a/b/../c', './x', '/', 'nested/dir/name.diff',
        '/trailing//slashes//', 'plain',
    ];
    for (const sample of samples) {
        assert.equal(shim.basename(sample), nodePath.posix.basename(sample), `basename(${sample})`);
        assert.equal(shim.dirname(sample), nodePath.posix.dirname(sample), `dirname(${sample})`);
        assert.equal(shim.normalize(sample), nodePath.posix.normalize(sample), `normalize(${sample})`);
    }
    assert.equal(shim.join('/repo', 'dir/file.c'), nodePath.posix.join('/repo', 'dir/file.c'));
    assert.equal(shim.join('a', '', 'b'), nodePath.posix.join('a', 'b'));
    assert.equal(shim.resolve('/base', 'child'), nodePath.posix.resolve('/base', 'child'));
});

test('web bundle builds, contains no Node built-in requires, and loads without Buffer or process', async t => {
    const config = await loadConfig();
    const esbuild = await optionalImport('esbuild');
    const polyfill = await optionalImport('buffer/');
    if (!config || !esbuild || !polyfill) {
        return t.skip('esbuild, the buffer polyfill, or esbuild.web.mjs is not installed');
    }
    const result = await esbuild.build(config.buildOptions({
        write: false,
        outfile: 'dist/web/extension.js',
        sourcemap: false,
        logLevel: 'silent',
    }));
    const bundle = result.outputFiles.find((file: { path: string }) => file.path.endsWith('extension.js'));
    assert.ok(bundle, 'the build must produce the bundle');
    const text: string = bundle.text;
    assert.ok(text.length > 10_000, 'the bundle should contain the extension sources');
    const externals = [...text.matchAll(/[^.\w]require\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]);
    assert.deepEqual([...new Set(externals)], ['vscode'], 'vscode must be the only external require');
    assert.ok(!/node:/.test(text.replace(/\/\/.*$/gm, '')), 'no node: specifiers may survive bundling');

    // A web worker has TextDecoder, crypto, and performance, but no Buffer, process, or Node require.
    const sandbox = {
        TextDecoder, TextEncoder, URLSearchParams, AbortController, console,
        setTimeout, clearTimeout, crypto: { getRandomValues: globalThis.crypto.getRandomValues.bind(crypto) },
        performance: globalThis.performance,
    };
    const context = vm.createContext(sandbox);
    vm.runInContext('globalThis.self = globalThis;', context);
    assert.equal(vm.runInContext('typeof Buffer', context), 'undefined');
    assert.equal(vm.runInContext('typeof process', context), 'undefined');
    const fabricated = new Map<PropertyKey, unknown>();
    const fabricate = (key: PropertyKey): unknown => {
        if (!fabricated.has(key)) {
            fabricated.set(key, class {});
        }
        return fabricated.get(key);
    };
    // esbuild's __toESM builds a namespace whose prototype is the required module's prototype,
    // so the fabricating Proxy must sit on the stub's prototype to serve vscode.* lookups.
    const vscodeStub: unknown = Object.create(new Proxy({}, { get: (_target, key) => fabricate(key) }));
    const load = new vm.Script(
        '(function (exports, module, require) {\n' + text + '\n})',
        { filename: 'extension.web.js' },
    ).runInContext(context);
    const moduleShim = { exports: {} as Record<string, unknown> };
    load(moduleShim.exports, moduleShim, (name: string) => {
        assert.equal(name, 'vscode', `the bundle must not require ${name} at load time`);
        return vscodeStub;
    });
    assert.equal(typeof moduleShim.exports.activate, 'function', 'the bundle must export activate');
    assert.equal(
        vm.runInContext('Buffer.from("abc").toString("hex")', context), '616263',
        'loading the bundle must install a working Buffer global',
    );
});
