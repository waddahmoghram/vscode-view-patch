// Bundles the extension for the web extension host (vscode.dev), where Node built-ins do not exist.
//
// The entry is src/browser.ts, which installs the `buffer` polyfill as the Buffer global and then
// re-exports the regular activate(). Node built-ins are replaced by the inline shims below:
//  - Modules the hunk-only path needs are implemented honestly (SHA-256, isUtf8, posix path helpers).
//  - Modules only the Git-backed path needs (child_process, fs, zlib, os.tmpdir) throw a clear
//    "not available in VS Code for the Web" error if they are ever reached. On the web the
//    controller finds no file-scheme repository candidates, so resolvePatch() returns no targets
//    without touching these shims and the existing "View Hunks Only" fallback dialog appears.
//
// Build:  node esbuild.web.mjs            (writes dist/web/extension.js + metafile)
// Check:  node esbuild.web.mjs --check    (in-memory build only, prints the bundle size)
//
// Requires the dev-only packages `esbuild` and `buffer` (verified with esbuild@0.28.2, buffer@6.0.3).

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const GIT_ONLY = `
function notAvailableOnWeb() {
    return new Error('Git-backed patch reviews are not available in VS Code for the Web. '
        + 'Use "View Patch Hunks Only" instead.');
}
async function rejectOnWeb() { throw notAvailableOnWeb(); }
`;

const SHA256 = `
const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
    constructor() {
        this.state = new Int32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]);
        this.block = new Uint8Array(64);
        this.blockBytes = 0;
        this.totalBytes = 0;
        this.words = new Int32Array(64);
    }

    update(data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
            : data instanceof Uint8Array ? data : new Uint8Array(data);
        this.totalBytes += bytes.length;
        let offset = 0;
        while (offset < bytes.length) {
            const take = Math.min(64 - this.blockBytes, bytes.length - offset);
            this.block.set(bytes.subarray(offset, offset + take), this.blockBytes);
            this.blockBytes += take;
            offset += take;
            if (this.blockBytes === 64) {
                this.compress();
                this.blockBytes = 0;
            }
        }
        return this;
    }

    compress() {
        const w = this.words;
        const block = this.block;
        for (let i = 0; i < 16; i++) {
            w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, h] = this.state;
        for (let i = 0; i < 64; i++) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + ch + K[i] + w[i]) | 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        const state = this.state;
        state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
        state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
        state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
        state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
    }

    digest(encoding) {
        const bitLength = this.totalBytes * 8;
        this.update(new Uint8Array([0x80]));
        while (this.blockBytes !== 56) {
            this.update(new Uint8Array([0]));
        }
        const length = new Uint8Array(8);
        new DataView(length.buffer).setBigUint64(0, BigInt(bitLength), false);
        this.update(length);
        const out = new Uint8Array(32);
        const view = new DataView(out.buffer);
        for (let i = 0; i < 8; i++) {
            view.setInt32(i * 4, this.state[i], false);
        }
        if (encoding === 'hex') {
            return [...out].map(byte => byte.toString(16).padStart(2, '0')).join('');
        }
        if (encoding !== undefined) {
            throw new Error('Only hex digests are available in VS Code for the Web.');
        }
        return BufferPolyfill.from(out.buffer, 0, 32);
    }
}

function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
}
`;

/**
 * ESM sources for every Node built-in the extension imports, keyed by specifier.
 * The bare specifier 'buffer' is intentionally absent so it resolves to the npm polyfill.
 */
export const shimSources = {
    child_process: `${GIT_ONLY}
export function spawn() { throw notAvailableOnWeb(); }
`,
    fs: `${GIT_ONLY}
export function existsSync() { throw notAvailableOnWeb(); }
export const promises = {
    stat: rejectOnWeb, mkdtemp: rejectOnWeb, mkdir: rejectOnWeb, writeFile: rejectOnWeb, rm: rejectOnWeb,
};
`,
    zlib: `${GIT_ONLY}
export function deflate(...args) { args[args.length - 1](notAvailableOnWeb()); }
`,
    os: `${GIT_ONLY}
export function homedir() {
    throw new Error('Home-folder (~) viewPatch.repositories entries are not available in VS Code for the Web.');
}
export function tmpdir() { throw notAvailableOnWeb(); }
`,
    perf_hooks: `export const performance = globalThis.performance;
`,
    util: `export const TextDecoder = globalThis.TextDecoder;
export function promisify(fn) {
    return (...args) => new Promise((resolve, reject) => {
        fn(...args, (error, value) => error ? reject(error) : resolve(value));
    });
}
`,
    'node:buffer': `export { Buffer } from 'buffer';
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
export function isUtf8(input) {
    try {
        strictUtf8.decode(input);
        return true;
    } catch (error) {
        if (error instanceof TypeError) {
            return false;
        }
        throw error;
    }
}
`,
    crypto: `import { Buffer as BufferPolyfill } from 'buffer';
${SHA256}
export function createHash(algorithm) {
    if (algorithm !== 'sha256') {
        throw new Error(\`Only sha256 hashes are available in VS Code for the Web, not \${algorithm}.\`);
    }
    return new Sha256();
}
export function randomBytes(size) {
    const bytes = new Uint8Array(size);
    globalThis.crypto.getRandomValues(bytes);
    return BufferPolyfill.from(bytes.buffer, 0, size);
}
`,
    // URI and repository paths in this extension are POSIX; Windows file-system paths cannot
    // occur on the web. Only the functions the sources call are provided.
    path: `export const sep = '/';
export function normalize(value) {
    if (value === '') { return '.'; }
    const absolute = value.startsWith('/');
    const trailing = /[/]$/.test(value) && value !== '/';
    const parts = [];
    for (const part of value.split('/')) {
        if (part === '' || part === '.') { continue; }
        if (part === '..') {
            if (parts.length && parts[parts.length - 1] !== '..') { parts.pop(); continue; }
            if (absolute) { continue; }
        }
        parts.push(part);
    }
    const joined = parts.join('/');
    const result = (absolute ? '/' : '') + joined + (trailing && joined ? '/' : '');
    return result || (absolute ? '/' : '.');
}
export function join(...values) {
    const joined = values.filter(value => value !== '').join('/');
    return joined === '' ? '.' : normalize(joined);
}
export function resolve(...values) {
    let resolved = '';
    for (let i = values.length - 1; i >= 0; i--) {
        resolved = resolved === '' ? values[i] : values[i] + '/' + resolved;
        if (resolved.startsWith('/')) { break; }
    }
    // The web worker has no working directory; relative inputs resolve from '/'.
    return normalize(resolved.startsWith('/') ? resolved : '/' + resolved);
}
export function basename(value, ext) {
    const stripped = value.replace(/[/]+$/, '');
    const base = stripped.slice(stripped.lastIndexOf('/') + 1) || (value.startsWith('/') ? '' : value);
    return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}
export function dirname(value) {
    const stripped = value.replace(/[/]+$/, '');
    if (stripped === '') { return value.startsWith('/') ? '/' : '.'; }
    const slash = stripped.lastIndexOf('/');
    if (slash < 0) { return '.'; }
    return slash === 0 ? '/' : stripped.slice(0, slash);
}
export const posix = { sep, normalize, join, resolve, basename, dirname };
export default { sep, normalize, join, resolve, basename, dirname, posix };
`,
};

const nodeShims = {
    name: 'node-shims',
    setup(build) {
        // Bare 'buffer' is intentionally not matched: it must resolve to the npm polyfill.
        const filter = /^(?:node:)?(?:child_process|fs|zlib|os|perf_hooks|util|crypto|path)$|^node:buffer$/;
        build.onResolve({ filter }, args => {
            const bare = args.path.replace(/^node:/, '');
            return { path: bare in shimSources ? bare : `node:${bare}`, namespace: 'node-shim' };
        });
        build.onLoad({ filter: /./, namespace: 'node-shim' }, args => ({
            contents: shimSources[args.path],
            loader: 'js',
            resolveDir: root,
        }));
    },
};

/** Options shared by the CLI build and the unit test's in-memory build. */
export function buildOptions(overrides = {}) {
    return {
        entryPoints: [path.join(root, 'src', 'browser.ts')],
        bundle: true,
        format: 'cjs',
        platform: 'browser',
        target: 'es2022',
        external: ['vscode'],
        mainFields: ['browser', 'module', 'main'],
        define: {
            // git.ts spreads process.env and repositories.ts reads process.platform on
            // Git-only paths; neither global exists in a web worker.
            'process.env': '{}',
            'process.platform': '"browser"',
        },
        plugins: [nodeShims],
        sourcemap: true,
        metafile: true,
        logLevel: 'info',
        ...overrides,
    };
}

async function main() {
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');
    const check = process.argv.includes('--check');
    const result = await esbuild.build(buildOptions(check
        ? { write: false, outfile: 'dist/web/extension.js', logLevel: 'silent' }
        : { outfile: path.join(root, 'dist', 'web', 'extension.js') }));
    const bundle = Object.entries(result.metafile.outputs).find(([name]) => name.endsWith('extension.js'));
    console.log(`Web bundle ${check ? 'checked' : 'written'}: ${bundle[0]} (${bundle[1].bytes} bytes).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
