// Entry point for the web extension host (vscode.dev). Bundled by esbuild.web.mjs, where the
// `buffer` import below resolves to the `buffer` npm polyfill; under Node it is the built-in,
// so this module is loadable (though unused) in the desktop build too.
import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
    // The sources use the Buffer global, which a web worker does not provide.
    (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

export { activate } from './extension';
export type { ShownPatch, ViewPatchApi } from './extension';
