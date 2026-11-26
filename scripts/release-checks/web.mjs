// Check B of the release runbook, automated: RELEASE_RUNBOOK.md section 7, "Manual check B: public vscode.dev", on
// the real https://vscode.dev, with View Patch installed from the Visual Studio Marketplace, driven in Chromium by
// Playwright. Each step asserts its expected results. report.mjs records them in report.md and report.json in the
// output folder, and a screenshot of each step goes to its shots/ folder.
//
//   node scripts/release-checks/web.mjs --version <x.y.z> [--channel regular|pre-release] [--out <dir>] [--headed]
//       [--profile <dir> | --sign-in-state <file>] [--allow-substitute]
//   node scripts/release-checks/web.mjs --sign-in --profile <dir> [--save-sign-in-state <file>]
//       [--timeout-minutes <n>]
//
// --version is the View Patch version the run must end up testing; with --channel pre-release, the run chooses
// Switch to Pre-Release Version after installing. The run uses one tab of a temporary Chromium profile, deleted at the
// end, unless --profile names a persistent one, created if missing and kept. The default --out is
// .release-checks/check-b.
//
// vscode.dev opens the GitHub patch of steps 6 and 7 only after a GitHub sign-in, and the run never signs in itself.
// Without --profile or --sign-in-state, those steps run through a substitute: the same patch with i/ and w/ prefixes,
// saved in the browser's private file storage and opened with File: Open File.... With a profile in which someone
// signed in to GitHub on vscode.dev, or a storage state saved from one, they run as written. If vscode.dev asks for a
// sign-in after all, step 6 fails, or, with --allow-substitute, the substitute runs instead.
//
// --sign-in is a one-time helper for a person, and nothing else runs: it opens headed Chromium on the --profile folder
// at the step 6 address and waits until they have signed in there. --save-sign-in-state <file> then saves the sign-in
// for runs elsewhere, such as GitHub Actions, once a new headless browser has opened the patch with it: <file> holds
// the JSON, and <file>.b64 its gzip, then base64, form for the secret VSCODE_DEV_SIGN_IN_STATE. When one secret cannot
// hold that, <file>.b64.1, .2, and on split it among VSCODE_DEV_SIGN_IN_STATE, VSCODE_DEV_SIGN_IN_STATE_2, and on.
// --sign-in-state reads either form. Both hold a GitHub token: keep them private, and never commit them.
//
// Exit codes, from report.mjs: 0 pass, 1 a step failed, 2 bad arguments, 3 a step did not run or the sign-in timed
// out; 130 after an interrupt. Headless Chromium needs no display; for --headed or --sign-in on a host without one,
// use xvfb-run -a.

import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { CheckReport, EXIT, errorText } from './report.mjs';

const ORIGIN = 'https://vscode.dev';
const START_URL = `${ORIGIN}/`;
const EXTENSION_ID = 'waddahmoghram.view-patch';
const PATCH_NAME = '0001-no-version-script-on-ohos.patch';
const GITHUB_PATCH_URL = `${ORIGIN}/github/microsoft/vcpkg/blob/master/ports/zlib/${PATCH_NAME}`;
const DEFAULT_OUT = path.join('.release-checks', 'check-b');
const NOT_SIGNED_IN = 'vscode.dev is not signed in to GitHub; refresh the sign-in with --sign-in';

const SIGN_IN_TEXT = /wants to sign in using GitHub|please sign in(?:to| to) GitHub/i;
const SIGN_IN_BUTTON = /^Sign in\b/i;
const UNAVAILABLE = /\b(?:unavailable|not (?:available|supported|compatible)|isn't supported|can(?:not|'t) install)/i;
const ABOUT_THE_WEB = /View Patch|for the Web|in the browser/i;
const NO_REPOSITORY = /No Git repository was found/i;
const WEB_NOTICE = /VS Code for the Web cannot run Git/;
const MODE_SWITCHES = ['Show Hunks Only for Review', 'Show Complete Files for Review'];
const INSTALL_BUTTON = /^(?:Trust Publisher & Install|Install Anyway)$/;
const FILE_ROW = /, (?:not )?reviewed(?:,|$)/;
const CLIPBOARD_SENTINEL = 'view-patch release check: waiting for the clipboard';

const KEPT_DATABASE_PREFIX = 'vscode-web-state-db-global';
const BUILT_IN_EXTENSIONS_KEY = 'additionalBuiltinExtensions';
const SECRET_NAME = 'VSCODE_DEV_SIGN_IN_STATE';
const SECRET_LIMIT = 48_000;
const SECRET_PIECE = 45_000;
const SECRET_PIECES = 4;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const LOAD_TIMEOUT = 90 * SECOND;
const UI_TIMEOUT = MINUTE;
const INSTALL_TIMEOUT = 3 * MINUTE;
const GITHUB_TIMEOUT = 3 * MINUTE;
const GITHUB_STALL = MINUTE;
const SIGN_IN_QUIET = 30 * SECOND;
// Notifications that a command shows can trail the review it opens.
const SETTLE = 1500;
const INTERRUPTED = 130;

const STEPS = new Map([
    ['1', 'Install and switch'],
    ['2', 'Identity gate'],
    ['2a', 'Browser extras'],
    ['3', 'Sample patch'],
    ['4', 'Clipboard patch'],
    ['5', 'Mark'],
    ['5a', 'Review menus'],
    ['6', 'GitHub patch'],
    ['7', 'Reload and reopen'],
    ['8', 'Clipboard on the reloaded page'],
]);

const CLIPBOARD_PATCH = [
    'diff --git i/hello.txt w/hello.txt',
    'index 1111111..2222222 100644',
    '--- i/hello.txt',
    '+++ w/hello.txt',
    '@@ -1 +1 @@',
    '-Hello',
    '+Hello, View Patch',
    '',
].join('\n');

// The substitute for steps 6 and 7: the vcpkg patch that step 6 opens from GitHub, whose a/ and b/ prefixes upstream
// are rewritten to i/ and w/ (729 bytes).
const SUBSTITUTE_PATCH = [
    'diff --git i/CMakeLists.txt w/CMakeLists.txt',
    'index 2ccbab9..77cee9b 100644',
    '--- i/CMakeLists.txt',
    '+++ w/CMakeLists.txt',
    '@@ -285,6 +285,7 @@ if(ZLIB_BUILD_SHARED)',
    '     if(UNIX',
    '         AND NOT APPLE',
    '         AND NOT (CMAKE_SYSTEM_NAME STREQUAL "AIX")',
    '+        AND NOT (CMAKE_SYSTEM_NAME STREQUAL "OHOS")',
    '         AND NOT (CMAKE_SYSTEM_NAME STREQUAL "SunOS"))',
    '         # On unix-like platforms the library is almost always called libz',
    '         set_target_properties(',
    '@@ -295,6 +296,7 @@ if(ZLIB_BUILD_SHARED)',
    '         UNIX',
    '         AND NOT APPLE',
    '         AND NOT (CMAKE_SYSTEM_NAME STREQUAL "AIX")',
    '+        AND NOT (CMAKE_SYSTEM_NAME STREQUAL "OHOS")',
    '         AND NOT (CMAKE_SYSTEM_NAME STREQUAL "SunOS"))',
    ' endif(ZLIB_BUILD_SHARED)',
    ' ',
    '',
].join('\n');

const USAGE = [
    'Usage:',
    '  node scripts/release-checks/web.mjs --version <x.y.z> [--channel regular|pre-release] [--out <dir>] [--headed]',
    '      [--profile <dir> | --sign-in-state <file>] [--allow-substitute]',
    '  node scripts/release-checks/web.mjs --sign-in --profile <dir> [--save-sign-in-state <file>]',
    '      [--timeout-minutes <n>]',
].join('\n');

class UsageError extends Error {}

const sessions = new Set();
let interrupted = false;

/** Reads the command line, throwing a UsageError for arguments that the run cannot start with. */
export function parseOptions(args) {
    let values;
    try {
        ({ values } = parseArgs({
            args,
            strict: true,
            options: {
                version: { type: 'string' },
                channel: { type: 'string' },
                out: { type: 'string' },
                headed: { type: 'boolean' },
                profile: { type: 'string' },
                'sign-in-state': { type: 'string' },
                'allow-substitute': { type: 'boolean' },
                'sign-in': { type: 'boolean' },
                'save-sign-in-state': { type: 'string' },
                'timeout-minutes': { type: 'string' },
                help: { type: 'boolean', short: 'h' },
            },
        }));
    } catch (error) {
        throw new UsageError(errorText(error));
    }
    const given = name => values[name] !== undefined;
    if (values.help) {
        return { help: true };
    }
    if (values['sign-in']) {
        const extra = ['version', 'channel', 'out', 'sign-in-state', 'allow-substitute'].filter(given);
        if (extra.length > 0) {
            const flags = extra.map(name => `--${name}`).join(', ');
            throw new UsageError(`--sign-in runs only the sign-in helper; drop ${flags}.`);
        }
        if (!given('profile')) {
            throw new UsageError('--sign-in needs --profile <dir>, the Chromium profile that keeps the sign-in.');
        }
        const minutes = Number(values['timeout-minutes'] ?? 10);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            throw new UsageError(`--timeout-minutes must be a positive number, not "${values['timeout-minutes']}".`);
        }
        return {
            signIn: true,
            profile: path.resolve(values.profile),
            saveSignInState: given('save-sign-in-state') ? path.resolve(values['save-sign-in-state']) : undefined,
            timeoutMinutes: minutes,
        };
    }
    for (const name of ['save-sign-in-state', 'timeout-minutes']) {
        if (given(name)) {
            throw new UsageError(`--${name} works only with --sign-in.`);
        }
    }
    if (!given('version')) {
        throw new UsageError('--version <x.y.z> is required: the View Patch version that the run must end up testing.');
    }
    if (!/^\d+\.\d+\.\d+$/.test(values.version)) {
        throw new UsageError(`--version must be a version such as 0.3.9, not "${values.version}".`);
    }
    const channel = values.channel ?? 'regular';
    if (channel !== 'regular' && channel !== 'pre-release') {
        throw new UsageError(`--channel must be regular or pre-release, not "${channel}".`);
    }
    if (given('profile') && given('sign-in-state')) {
        throw new UsageError('Give --profile or --sign-in-state, not both.');
    }
    return {
        version: values.version,
        channel,
        out: path.resolve(values.out ?? DEFAULT_OUT),
        headed: values.headed === true,
        profile: given('profile') ? path.resolve(values.profile) : undefined,
        signInState: values['sign-in-state'],
        allowSubstitute: values['allow-substitute'] === true,
    };
}

/**
 * Keeps what a vscode.dev GitHub sign-in needs, small enough for secrets: every origin's localStorage, IndexedDB only
 * for vscode.dev's global state databases, and only vscode.dev's cookies, unless `everyCookie`. Every cookie can
 * include github.com's own sign-in, a web session for the account that is more than vscode.dev keeps. The rest of
 * vscode.dev's IndexedDB holds logs, user files, file handles, and the state of each workspace. The user files
 * include the cached manifests of the extensions that vscode.dev builds in, such as GitHub Repositories, while the
 * global state lists those extensions: the list without the manifests stops GitHub Repositories from loading at
 * all, so the list goes too, and vscode.dev fetches both again, as in a new profile.
 */
export function trimStorageState(state, { everyCookie = false } = {}) {
    const origins = [];
    for (const entry of state.origins ?? []) {
        const localStorage = entry.localStorage ?? [];
        const indexedDB = isOrigin(entry.origin, ORIGIN)
            ? (entry.indexedDB ?? []).filter(database => database.name.startsWith(KEPT_DATABASE_PREFIX))
                .map(database => ({
                    ...database,
                    stores: database.stores.map(store => ({
                        ...store,
                        records: store.records.filter(record => record.key !== BUILT_IN_EXTENSIONS_KEY),
                    })),
                }))
            : [];
        if (indexedDB.length > 0) {
            origins.push({ origin: entry.origin, localStorage, indexedDB });
        } else if (localStorage.length > 0) {
            origins.push({ origin: entry.origin, localStorage });
        }
    }
    const cookies = (state.cookies ?? []).filter(cookie => everyCookie || isVscodeDevCookie(cookie));
    return { cookies, origins };
}

function isVscodeDevCookie(cookie) {
    const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    return domain === 'vscode.dev' || domain.endsWith('.vscode.dev');
}

function cookieDomains(state) {
    return [...new Set((state.cookies ?? []).map(cookie => String(cookie.domain).replace(/^\./, '')))].sort();
}

/** The form that a secret holds: the JSON compressed with gzip, then base64, on one line. */
export function encodeState(json) {
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    return gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');
}

/** Reads a storage state from its JSON, or from encodeState's form, whichever `text` holds. */
export function decodeState(text) {
    const content = String(text).trim();
    let json = content;
    if (!content.startsWith('{')) {
        try {
            json = gunzipSync(Buffer.from(content.replace(/\s+/g, ''), 'base64')).toString('utf8');
        } catch (error) {
            throw new Error(`it is neither JSON nor gzip, then base64, text (${errorText(error)})`);
        }
    }
    const state = JSON.parse(json);
    if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) {
        throw new Error('it is not a Playwright storage state, which lists cookies and origins');
    }
    return state;
}

/** Splits encodeState's text into the pieces that the workflow joins, or returns it whole when one secret holds it. */
export function splitSecret(encoded) {
    if (encoded.length <= SECRET_LIMIT) {
        return [encoded];
    }
    const pieces = [];
    for (let start = 0; start < encoded.length; start += SECRET_PIECE) {
        pieces.push(encoded.slice(start, start + SECRET_PIECE));
    }
    if (pieces.length > SECRET_PIECES) {
        throw new Error(`The encoded state has ${count(encoded.length)} characters: ${pieces.length} pieces of at most`
            + ` ${count(SECRET_PIECE)}, more than the ${SECRET_PIECES} that the workflow joins.`);
    }
    return pieces;
}

/** The secret that holds the piece at `index` (from 0) of splitSecret's result. */
export function secretName(index) {
    return index === 0 ? SECRET_NAME : `${SECRET_NAME}_${index + 1}`;
}

/**
 * Starts Chromium with one page. Without `profile`, it uses a temporary profile, seeded from `signInState` when
 * given, which close() deletes. An automated session can read and write the clipboard, and installs pageHooks.
 */
export async function openSession({ profile, signInState, headed = false, automated = true } = {}) {
    const temporary = profile === undefined;
    const session = new Session(temporary ? await mkdtemp(path.join(tmpdir(), 'view-patch-check-b-')) : profile,
        temporary);
    try {
        await mkdir(session.userDataDir, { recursive: true });
        session.context = await chromium.launchPersistentContext(session.userDataDir, {
            headless: !headed,
            viewport: automated ? { width: 1600, height: 1000 } : null,
            // main() handles these signals itself, so that a temporary profile is deleted too.
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
        });
        if (interrupted) {
            throw new Error('the run was interrupted');
        }
        if (signInState) {
            await session.context.setStorageState(signInState);
        }
        if (automated) {
            session.context.setDefaultTimeout(UI_TIMEOUT);
            await session.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
            await session.context.addInitScript(pageHooks, { name: PATCH_NAME, content: SUBSTITUTE_PATCH });
        }
        session.page = session.context.pages()[0] ?? await session.context.newPage();
        if (automated) {
            // A reload must not wait on a "Leave site?" prompt.
            session.page.on('dialog', dialog => void (dialog.type() === 'beforeunload'
                ? dialog.accept()
                : dialog.dismiss()).catch(() => {}));
        }
        session.version = await browserVersion(session.context, session.page);
        return session;
    } catch (error) {
        await session.close();
        throw error;
    }
}

class Session {
    constructor(userDataDir, temporary) {
        this.userDataDir = userDataDir;
        this.temporary = temporary;
        this.context = undefined;
        this.page = undefined;
        this.version = undefined;
        sessions.add(this);
    }

    async close() {
        sessions.delete(this);
        const context = this.context;
        this.context = undefined;
        await context?.close().catch(() => {});
        if (this.temporary) {
            await rm(this.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    }
}

/**
 * Runs in the page before vscode.dev does. It records each notification and dialog as it appears, since toasts
 * vanish, and serves the substitute patch to File: Open File... from the origin private file system, once armed.
 */
function pageHooks({ name, content }) {
    if (window.top !== window || globalThis.__viewPatchCheck) {
        return;
    }
    const state = { events: [], armed: false, unexpectedPicker: 0 };
    globalThis.__viewPatchCheck = state;
    const recorded = new WeakMap();
    const severity = element => {
        const classes = element?.className ?? '';
        return /error/.test(classes) ? 'error' : /warning/.test(classes) ? 'warning' : 'info';
    };
    const record = (kind, element, text, level) => {
        const key = `${level} ${text}`;
        if (text && recorded.get(element) !== key) {
            recorded.set(element, key);
            const buttons = [...element.querySelectorAll('.monaco-button')].map(button => button.textContent.trim());
            state.events.push({ kind, severity: level, text, buttons, time: Date.now() });
        }
    };
    setInterval(() => {
        for (const item of document.querySelectorAll('.notification-list-item')) {
            const message = item.querySelector('.notification-list-item-message')?.textContent.trim();
            record('notification', item, message, severity(item.querySelector('.notification-list-item-icon')));
        }
        for (const box of document.querySelectorAll('.monaco-dialog-box')) {
            const parts = [...box.querySelectorAll('.dialog-message-text, .dialog-message-detail')];
            const message = parts.map(part => part.textContent.trim()).filter(Boolean).join(' ');
            record('dialog', box, message, severity(box.querySelector('.dialog-icon')));
        }
    }, 200);
    window.showOpenFilePicker = async () => {
        if (!state.armed) {
            state.unexpectedPicker += 1;
            throw new DOMException('The release check supplies a file only to its substitute step.', 'AbortError');
        }
        state.armed = false;
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return [handle];
    };
}

class CheckRun {
    constructor(options) {
        this.options = options;
        const signIn = options.profile ? 'persistent profile'
            : options.signInState ? 'storage state' : 'none (substitute for steps 6 and 7)';
        this.report = new CheckReport({
            check: 'B',
            title: 'Check B: public vscode.dev',
            target: {
                'View Patch': `${options.version} (${options.channel})`,
                Editor: 'unknown (the identity gate did not run)',
                Browser: 'Chromium (not started)',
                'GitHub sign-in': signIn,
            },
        });
        this.shots = path.join(options.out, 'shots');
        this.session = undefined;
        this.reloaded = false;
    }

    get page() {
        return this.session.page;
    }

    async run() {
        await mkdir(this.shots, { recursive: true });
        try {
            this.session = await openSession({
                profile: this.options.profile,
                signInState: this.options.signInState,
                headed: this.options.headed,
            });
            this.report.target.Browser = `Chromium ${this.session.version}`;
        } catch (error) {
            this.report.fail('1', STEPS.get('1'), `Chromium did not start: ${errorText(error)}`);
            this.skipRest('step 1 failed');
            return this.finish();
        }
        try {
            await this.steps();
        } catch (error) {
            this.report.note(`The run stopped early: ${errorText(error)}`);
            this.skipRest(interrupted ? 'the run was interrupted' : `the run stopped: ${errorText(error)}`);
        } finally {
            await this.session.close();
        }
        return this.finish();
    }

    finish() {
        this.report.note(`Screenshots: ${this.shots}`);
        const exitCode = this.report.write(this.options.out);
        return interrupted ? INTERRUPTED : exitCode;
    }

    async steps() {
        if (!await this.step('1', () => this.installAndSwitch())) {
            return this.skipRest('step 1 failed');
        }
        if (!await this.step('2', () => this.identityGate())) {
            return this.skipRest('the identity gate failed');
        }
        await this.step('2a', () => this.browserExtras());
        await this.step('3', () => this.samplePatch());
        if (await this.step('4', () => this.clipboardPatch())) {
            await this.step('5', () => this.markHello());
        } else {
            this.report.notRun('5', STEPS.get('5'), 'step 4 opened no review to mark');
        }
        await this.step('5a', () => this.reviewMenus());
        const github = await this.chooseGitHubRoute();
        const substitute = github.route === 'substitute';
        const openPatch = {
            'as written': () => this.githubPatch(github.waited),
            substitute: () => this.substitutePatch(),
            failed: async () => {
                throw new Error(github.reason);
            },
        }[github.route];
        if (await this.step('6', openPatch, { substitute })) {
            await this.step('7', () => this.reloadAndReopen(substitute), { substitute });
        } else {
            this.report.notRun('7', STEPS.get('7'), 'step 6 failed');
        }
        await this.step('8', () => this.clipboardOnReloadedPage(github.route));
        await this.captureOutput('View Patch output at the end of the run');
    }

    /** Runs one step, then takes its screenshot. Returns whether it passed. */
    async step(id, task, { substitute = false } = {}) {
        if (interrupted) {
            throw new Error('the run was interrupted');
        }
        const name = STEPS.get(id);
        const passed = await this.report.run(id, name, async () => {
            try {
                return await task();
            } catch (error) {
                throw interrupted ? new Error(`the run was interrupted (${errorText(error)})`) : error;
            }
        }, { substitute });
        await this.shot(`${id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
        if (interrupted || this.page.isClosed()) {
            throw new Error(interrupted ? 'the run was interrupted' : 'the browser page closed');
        }
        return passed;
    }

    skipRest(reason) {
        const recorded = new Set(this.report.steps.map(step => step.id));
        for (const [id, name] of STEPS) {
            if (!recorded.has(id)) {
                this.report.notRun(id, name, reason);
            }
        }
    }

    async shot(name) {
        await this.page.screenshot({ path: path.join(this.shots, `${name}.png`) }).catch(() => {});
    }

    async load(url) {
        if (await load(this.page, url)) {
            const where = url ? `at ${url}` : 'on a reload';
            this.report.note(`vscode.dev stayed blank ${where}, so the run loaded the page again.`);
        }
    }

    async captureOutput(label) {
        try {
            this.report.attach(label, await viewPatchOutput(this.page));
        } catch (error) {
            this.report.note(`${label}: not captured (${errorText(error)})`);
        }
    }

    async installAndSwitch() {
        const page = this.page;
        const since = Date.now();
        await this.load(START_URL);
        const row = await findExtension(page);
        const done = [];
        const install = row.locator('.action-label.install:visible', { hasText: /^Install$/ });
        if (await install.count() > 0) {
            await install.first().click();
            const accepted = await finishInstall(page, row);
            done.push(accepted.length > 0
                ? `Installed from the Marketplace, accepting ${accepted.join(' and ')}`
                : 'Installed from the Marketplace');
        } else {
            done.push('Already installed in this profile');
        }
        const header = await openDetails(page, row);
        const action = text => header.locator('.action-label:visible', { hasText: exactly(text) });
        const update = header.locator('.action-label:visible', { hasText: /^Update to v/ });
        if (await update.count() > 0) {
            done.push(`chose ${(await update.first().innerText()).trim()}`);
            await update.first().click();
            await waitUntil(async () => await update.count() === 0, INSTALL_TIMEOUT, 'The update did not finish.');
        }
        if (this.options.channel === 'pre-release') {
            if (await action('Switch to Pre-Release Version').count() > 0) {
                await action('Switch to Pre-Release Version').first().click();
                await waitUntil(async () => await action('Switch to Release Version').count() > 0, INSTALL_TIMEOUT,
                    `Switch to Pre-Release Version did not finish within ${INSTALL_TIMEOUT / MINUTE} minutes.`);
                done.push('chose Switch to Pre-Release Version');
            } else if (await action('Switch to Release Version').count() > 0) {
                done.push('it was already the pre-release version');
            } else {
                throw new Error('The View Patch details offer no Switch to Pre-Release Version: the Marketplace may'
                    + ' have no pre-release newer than the release.');
            }
        } else if (await action('Switch to Release Version').count() > 0) {
            await action('Switch to Release Version').first().click();
            await waitUntil(async () => await action('Switch to Release Version').count() === 0, INSTALL_TIMEOUT,
                'Switch to Release Version did not finish.');
            done.push('chose Switch to Release Version, since this profile had the pre-release version');
        }
        const version = await detailsVersion(page);
        const preRelease = await action('Switch to Release Version').count() > 0;
        const texts = [
            ...(await uiEvents(page, since)).map(event => event.text),
            await row.getAttribute('aria-label'),
            await row.innerText(),
            await header.innerText(),
        ];
        const unavailable = texts.filter(text => text && UNAVAILABLE.test(text) && ABOUT_THE_WEB.test(text));
        await this.shot('1-details');
        if (unavailable.length > 0) {
            throw new Error(`vscode.dev says that View Patch is not available: ${quoted(unavailable)}.`);
        }
        await this.load();
        return `${done.join('; ')}. The details then showed version ${version}${preRelease ? ', pre-release' : ''}; no`
            + ' message said that View Patch is unavailable in VS Code for the Web. The page was then reloaded.';
    }

    async identityGate() {
        const { version, channel } = this.options;
        const diagnostics = await this.copyDiagnostics();
        this.report.attach('Copy Diagnostics', diagnostics.text);
        const lines = diagnostics.text.split(/\r?\n/);
        const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
        const editor = field('Editor');
        if (editor) {
            this.report.target.Editor = editor;
        }
        const wrong = [];
        if (lines[0] !== `View Patch ${version}`) {
            wrong.push(`the first line is \`${lines[0]}\`, so View Patch ${lines[0].replace(/^View Patch /, '')} is`
                + ` loaded, not the expected ${version}; the Marketplace may not offer ${version} on the ${channel}`
                + ' channel yet');
        }
        const expected = [
            ['Remote', '(none)'],
            ['Platform', 'browser (no Node.js)'],
            ['Git version', 'unavailable: VS Code for the Web cannot run Git.'],
        ];
        for (const [name, value] of expected) {
            if (field(name) !== value) {
                wrong.push(`\`${name}: ${field(name) ?? '(missing)'}\`, not \`${name}: ${value}\``);
            }
        }
        if (wrong.length > 0) {
            throw new Error(`Copy Diagnostics: ${wrong.join('; ')}.`);
        }
        const shown = [`View Patch ${version}`, `Editor: ${editor}`, ...expected.map(entry => entry.join(': '))]
            .map(line => `\`${line}\``).join(', ');
        return diagnostics.retried ? `${shown}. ${diagnostics.retried}` : shown;
    }

    /**
     * Runs Copy Diagnostics and returns the text it put on the clipboard. When the clipboard does not change, View
     * Patch's log tells whether the command ran: if it did, the copy failed; if not, the command runs once more.
     */
    async copyDiagnostics() {
        const page = this.page;
        let retried;
        for (let attempt = 1; ; attempt += 1) {
            await writeClipboard(page, CLIPBOARD_SENTINEL);
            const since = Date.now();
            await runCommand(page, 'View Patch: Copy Diagnostics');
            let held = '';
            const text = await poll(async () => {
                held = await readClipboard(page);
                return held.startsWith('View Patch ') ? held : undefined;
            }, 20 * SECOND);
            if (text) {
                return { text, retried };
            }
            const shown = (await uiEvents(page, since)).map(describeEvent);
            const ran = (await viewPatchOutput(page).catch(() => '')).includes('Diagnostics copied:');
            const clipboard = held === CLIPBOARD_SENTINEL ? 'the run\'s placeholder' : 'other text, not shown here';
            const what = `Copy Diagnostics left ${clipboard} on the clipboard for 20 s`
                + `${shown.length > 0 ? `, and ${shown.join(', and ')}` : ''}`;
            if (ran || attempt === 2) {
                const log = ran
                    ? 'View Patch\'s log says that it copied them'
                    : 'View Patch\'s log has no sign that it ran';
                throw new Error(`${retried ? `${retried} ` : ''}${what}; ${log}.`);
            }
            retried = `On the first try, ${what}, and View Patch's log had no sign that it ran, so it ran again.`;
        }
    }

    async browserExtras() {
        const page = this.page;
        const { version } = this.options;
        await showReviews(page);
        const pane = reviewsPane(page);
        const wrong = [];
        const description = (await pane.locator('.pane-header .description').innerText()).trim();
        if (description !== `v${version} · browser`) {
            wrong.push(`the Patch Reviews title reads \`${description}\`, not \`v${version} · browser\``);
        }
        const welcome = pane.locator('.welcome-view-content');
        const buttons = await visibleWithin(welcome, UI_TIMEOUT)
            ? (await welcome.locator('.monaco-button').allInnerTexts()).map(text => text.trim())
            : [];
        if (buttons.length !== 6) {
            wrong.push(`the empty view shows ${buttons.length} welcome buttons, not six: ${buttons.join(', ')}`);
        }
        const since = Date.now();
        await runCommand(page, 'View Patch: Show Environment');
        const environment = await poll(async () => (await uiEvents(page, since))
            .find(event => event.kind === 'notification' && event.text.startsWith('View Patch '))?.text, 30 * SECOND);
        const expected = `View Patch ${version} is running in the browser, which cannot run Git, so patches open as`
            + ' hunks only.';
        if (environment !== expected) {
            wrong.push(`Show Environment showed ${environment ? `"${environment}"` : 'nothing'}, not "${expected}"`);
        }
        await runCommand(page, 'View Patch: Show View Patch Output');
        const output = await poll(async () => {
            const panel = await outputPanel(page);
            return panel.view === 'Output' && panel.channel === 'View Patch';
        }, 30 * SECOND);
        if (!output) {
            const panel = await outputPanel(page);
            wrong.push(`Show View Patch Output left the panel on ${panel.view || 'nothing'}, channel`
                + ` ${panel.channel || 'none'}`);
        }
        await runCommand(page, 'Notifications: Clear All Notifications');
        if (wrong.length > 0) {
            throw new Error(`${wrong.join('; ')}.`);
        }
        return `The empty Patch Reviews view's title reads \`v${version} · browser\`, and its six welcome buttons`
            + ` show: ${buttons.join(', ')}. Show Environment: "${environment}" Show View Patch Output selected the`
            + ' View Patch output channel.';
    }

    async samplePatch() {
        const page = this.page;
        await showReviews(page);
        const before = new Set((await reviewTree(page)).map(review => review.name));
        const since = Date.now();
        await runCommand(page, 'View Patch: Open Sample Patch');
        const review = await waitForReview(page, candidate => !before.has(candidate.name) && candidate.files.length > 0,
            'The sample review');
        await sleep(SETTLE);
        const wrong = problems(await uiEvents(page, since)).map(describeEvent);
        const names = review.files.map(file => file.name);
        if ([...names].sort().join('\n') !== ['README.md', 'src/greeting.ts'].join('\n')) {
            wrong.push(`the review lists ${quoted(names)}, not \`src/greeting.ts\` and \`README.md\``);
        }
        if (!review.label.includes('hunks only')) {
            wrong.push(`the review reads \`${review.label}\`, not hunks only`);
        }
        const whole = review.files.filter(file => !file.label.endsWith('partial context'));
        if (whole.length > 0) {
            wrong.push(`${quoted(whole.map(file => file.label))} do not say partial context`);
        }
        if (wrong.length > 0) {
            throw new Error(`Open Sample Patch: ${wrong.join('; ')}.`);
        }
        return `A hunk-only review, \`${review.label}\`, of \`src/greeting.ts\` and \`README.md\`, whose rows read`
            + ` ${quoted(review.files.map(file => file.label))}`;
    }

    async clipboardPatch() {
        const page = this.page;
        await showReviews(page);
        const before = new Set((await reviewTree(page)).map(review => review.name));
        await writeClipboard(page, CLIPBOARD_PATCH);
        const since = Date.now();
        await runCommand(page, 'View Patch: Open Patch from Clipboard');
        const review = await waitForReview(page, candidate => !before.has(candidate.name) && candidate.files.length > 0,
            'The clipboard review');
        await sleep(SETTLE);
        const events = await uiEvents(page, since);
        const wrong = problems(events).map(describeEvent);
        const names = review.files.map(file => file.name);
        if (names.join('\n') !== 'hello.txt') {
            wrong.push(`the review lists ${quoted(names)}, not \`hello.txt\``);
        }
        if (!review.label.includes('hunks only')) {
            wrong.push(`the review reads \`${review.label}\`, not hunks only`);
        }
        if (wrong.length > 0) {
            throw new Error(`Open Patch from Clipboard: ${wrong.join('; ')}.`);
        }
        const notice = events.some(event => event.kind === 'notification' && WEB_NOTICE.test(event.text));
        return `No error prompt; a hunk-only review, \`${review.name}\`, lists \`hello.txt\`, not \`i/hello.txt\`. The`
            + ` one-time notice that VS Code for the Web cannot run Git ${notice ? 'appeared' : 'did not appear'}.`;
    }

    async markHello() {
        const page = this.page;
        await showReviews(page);
        const before = await fileRow(page, 'hello.txt').getAttribute('aria-label');
        const expected = 'hello.txt, modified, not reviewed, partial context';
        if (before !== expected) {
            throw new Error(`Before marking, \`hello.txt\` reads \`${before}\`, not \`${expected}\`.`);
        }
        const after = await toggleReviewed(page, 'hello.txt', true);
        if (after !== 'hello.txt, modified, reviewed, partial context') {
            throw new Error(`After Toggle Reviewed, \`hello.txt\` reads \`${after}\`.`);
        }
        return `\`hello.txt\` shows as reviewed: its accessible label changed from \`${before}\` to \`${after}\``;
    }

    async reviewMenus() {
        const page = this.page;
        await showReviews(page);
        const roots = reviewsPane(page).locator('.monaco-list-row[aria-level="1"]');
        const menus = [];
        for (let index = 0; index < await roots.count(); index += 1) {
            const root = roots.nth(index);
            const name = (await root.getAttribute('aria-label')).split(', ')[0];
            menus.push({ name, items: await contextMenu(page, root) });
        }
        if (menus.length === 0) {
            throw new Error('Patch Reviews lists no review whose context menu to open.');
        }
        const list = items => items.map(item => (item.disabled ? `${item.text} (disabled)` : item.text)).join(', ');
        const offering = menus.filter(menu => menu.items.some(item => MODE_SWITCHES.includes(item.text)));
        if (offering.length > 0) {
            throw new Error(offering.map(menu => `The context menu of ${menu.name} offers ${list(menu.items)}`)
                .join('; ') + '.');
        }
        const offered = menus.every(menu => list(menu.items) === list(menus[0].items))
            ? `The context menu of each of the ${menus.length} reviews offered ${list(menus[0].items)}`
            : menus.map(menu => `The context menu of ${menu.name} offered ${list(menu.items)}`).join('; ');
        return `${offered}; none offered ${MODE_SWITCHES.join(' or ')}`;
    }

    /** Decides how steps 6 and 7 run: 'as written', 'substitute', or 'failed' with the reason. */
    async chooseGitHubRoute() {
        const { profile, signInState, allowSubstitute } = this.options;
        if (!profile && !signInState) {
            this.report.note('Steps 6 and 7 ran through the substitute: without --profile or --sign-in-state, the run'
                + ` has no GitHub sign-in, so it did not open ${GITHUB_PATCH_URL}.`);
            return { route: 'substitute' };
        }
        let opened;
        try {
            opened = await openGitHubPatch(this.page);
        } catch (error) {
            return { route: 'failed', reason: errorText(error) };
        }
        if (opened.signedIn) {
            return { route: 'as written', waited: waited(opened) };
        }
        await this.shot('6-sign-in-prompt');
        await cancelDialogs(this.page);
        if (!allowSubstitute) {
            return {
                route: 'failed',
                reason: `${NOT_SIGNED_IN} (${waited(opened)}, vscode.dev showed "${opened.prompt}")`,
            };
        }
        this.report.target['GitHub sign-in'] += ', not signed in (substitute for steps 6 and 7)';
        this.report.note(`vscode.dev was not signed in to GitHub: ${waited(opened)}, it showed`
            + ` "${opened.prompt}". As --allow-substitute allows, steps 6 and 7 ran through the substitute.`);
        return { route: 'substitute' };
    }

    async githubPatch(waitedFor) {
        const page = this.page;
        const since = Date.now();
        if (!await poll(() => patchShown(page), UI_TIMEOUT)) {
            throw new Error(`${PATCH_NAME} is not the active editor, with its text shown.`);
        }
        const review = await this.openPatchAsChanges(since);
        return `${GITHUB_PATCH_URL} opened ${PATCH_NAME}, with no sign-in prompt ${waitedFor}. ${review}`;
    }

    async substitutePatch() {
        const page = this.page;
        if (new URL(page.url()).pathname !== '/') {
            await this.load(START_URL);
        }
        const since = Date.now();
        await page.evaluate(() => {
            globalThis.__viewPatchCheck.armed = true;
        });
        await runCommand(page, 'File: Open File...');
        if (!await poll(() => patchShown(page), UI_TIMEOUT)) {
            throw new Error(`File: Open File... did not open ${PATCH_NAME} from the browser's private file storage.`);
        }
        const review = await this.openPatchAsChanges(since);
        return 'Substitute: the `i/` and `w/` copy of the patch, saved in the browser\'s private file storage and'
            + ` opened with File: Open File.... ${review}`;
    }

    async openPatchAsChanges(since) {
        const page = this.page;
        await showReviews(page);
        await runCommand(page, 'View Patch: Open Patch as Changes');
        const review = await waitForReview(page, candidate => candidate.name === PATCH_NAME
            && candidate.files.length > 0, `A review of ${PATCH_NAME}`);
        await sleep(SETTLE);
        const wrong = problems(await uiEvents(page, since)).map(describeEvent);
        if (await page.evaluate(() => globalThis.__viewPatchCheck?.unexpectedPicker ?? 0) > 0) {
            wrong.push('View Patch asked for a file instead of reading the active editor');
        }
        const names = review.files.map(file => file.name);
        if (names.join('\n') !== 'CMakeLists.txt') {
            wrong.push(`the review lists ${quoted(names)}, not \`CMakeLists.txt\``);
        }
        if (!review.label.includes('hunks only')) {
            wrong.push(`the review reads \`${review.label}\`, not hunks only`);
        }
        if (wrong.length > 0) {
            throw new Error(`Open Patch as Changes: ${wrong.join('; ')}.`);
        }
        return 'Open Patch as Changes showed no "No Git repository was found" warning, and a hunk-only review lists'
            + ` \`CMakeLists.txt\`, with no \`a/\`, \`b/\`, \`i/\`, or \`w/\` prefix: \`${review.files[0].label}\``;
    }

    async reloadAndReopen(substitute) {
        const page = this.page;
        await showReviews(page);
        const marked = await markReviewed(page, 'CMakeLists.txt');
        await this.captureOutput('View Patch output before the step 7 reload');
        await this.load();
        this.reloaded = true;
        const since = Date.now();
        await showReviews(page);
        await runCommand(page, 'View Patch: Reopen Recent Patch...');
        const choice = await pickRecent(page, substitute);
        const review = await waitForReview(page, candidate => candidate.name === PATCH_NAME
            && candidate.files.length > 0, `The reopened review of ${PATCH_NAME}`);
        await sleep(SETTLE);
        const file = review.files.find(entry => entry.name === 'CMakeLists.txt');
        const wrong = problems(await uiEvents(page, since)).map(describeEvent);
        if (!isReviewed(file?.label)) {
            wrong.push(`\`CMakeLists.txt\` reads \`${file?.label ?? '(missing)'}\`, not reviewed`);
        }
        if (wrong.length > 0) {
            throw new Error(`After the reload, Reopen Recent Patch...: ${wrong.join('; ')}.`);
        }
        const again = marked.cleared
            ? ' (an earlier run in this profile had marked it, so the run cleared the mark and set it again)'
            : '';
        const listed = [choice.description, choice.detail].filter(Boolean).join(', ');
        return `${substitute ? 'Substitute: after' : 'After'} marking \`CMakeLists.txt\` reviewed${again} and`
            + ` reloading, Reopen Recent Patch... listed \`${choice.label}\` (${listed}), and the review reopened`
            + ` with \`${file.label}\``;
    }

    async clipboardOnReloadedPage(route) {
        if (!this.reloaded) {
            await this.load(route === 'failed' ? START_URL : undefined);
            this.reloaded = true;
        }
        return `On the reloaded page: ${await this.clipboardPatch()}`;
    }
}

/**
 * Opens `url`, or reloads the page when it is undefined, and waits for the workbench. vscode.dev now and then stays
 * blank, so a second attempt follows; the result tells whether one was needed.
 */
async function load(page, url) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const navigation = { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT };
        await (url ? page.goto(url, navigation) : page.reload(navigation));
        if (await visibleWithin(page.locator('.monaco-workbench .part.statusbar'), LOAD_TIMEOUT)) {
            return attempt > 1;
        }
    }
    throw new Error(`vscode.dev showed no workbench at ${url ?? page.url()} within ${LOAD_TIMEOUT / SECOND} s, twice.`);
}

/**
 * Runs a command from the Command Palette, choosing the entry whose label is exactly `title`. The palette lists the
 * commands known when it opens, so it opens again until an extension that is still loading has added its commands.
 */
async function runCommand(page, title) {
    const input = page.locator('.quick-input-widget input.input');
    const entry = page.locator('.quick-input-widget .monaco-list-row', {
        has: page.locator('.label-name', { hasText: exactly(title) }),
    }).first();
    const deadline = Date.now() + UI_TIMEOUT;
    let opened = false;
    while (Date.now() < deadline) {
        // The shortcut also replaces any other picker. A palette that is closing stays visible but inert for a
        // moment, so typing waits only briefly before the palette opens again.
        await page.keyboard.press('Control+Shift+P');
        if (!await visibleWithin(input, 5 * SECOND)) {
            await page.keyboard.press('F1');
        }
        if (!await input.fill(`>${title}`, { timeout: 5 * SECOND }).then(() => true, () => false)) {
            continue;
        }
        opened = true;
        if (await visibleWithin(entry, 5 * SECOND)) {
            await entry.click();
            return;
        }
        await page.keyboard.press('Escape');
    }
    throw new Error(opened
        ? `The Command Palette has no ${title} command.`
        : `The Command Palette did not open to run ${title}.`);
}

async function findExtension(page) {
    await page.keyboard.press('Control+Shift+X');
    const search = page.locator('.extensions-viewlet .suggest-input-container');
    await search.waitFor({ timeout: UI_TIMEOUT });
    await search.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(EXTENSION_ID, { delay: 20 });
    const row = page.locator(`.extensions-viewlet .monaco-list-row[data-extension-id="${EXTENSION_ID}"]`).first();
    const install = row.locator('.action-label.install:visible', { hasText: /^Install$/ });
    const manage = row.locator('.action-label[aria-label="Manage"]:visible');
    // The row's actions show a moment after the row itself.
    await waitUntil(async () => await install.count() > 0 || await manage.count() > 0, UI_TIMEOUT,
        `Searching the Extensions view for ${EXTENSION_ID} found no View Patch to install or manage.`);
    return row;
}

/** Accepts the publisher-trust and limited-functionality dialogs until View Patch is installed. */
async function finishInstall(page, row) {
    const accepted = [];
    const deadline = Date.now() + INSTALL_TIMEOUT;
    while (await row.locator('.action-label[aria-label="Manage"]:visible').count() === 0) {
        const dialog = page.locator('.monaco-dialog-box:visible').first();
        if (await dialog.count() > 0) {
            const { message, detail } = await dialogText(dialog);
            const button = dialog.locator('.monaco-button', { hasText: INSTALL_BUTTON }).first();
            if (UNAVAILABLE.test(`${message} ${detail}`) || await button.count() === 0) {
                throw new Error(`Installing showed the dialog "${[message, detail].filter(Boolean).join(' ')}".`);
            }
            const label = (await button.innerText()).trim();
            await button.click();
            accepted.push(`"${message}" (${label})`);
            const next = page.locator('.monaco-dialog-box:visible').first();
            const replaced = async () => await next.count() === 0 || (await dialogText(next)).message !== message;
            await poll(replaced, 10 * SECOND);
        } else if (Date.now() > deadline) {
            throw new Error(`View Patch was not installed within ${INSTALL_TIMEOUT / MINUTE} minutes.`);
        } else {
            await sleep(500);
        }
    }
    return accepted;
}

async function openDetails(page, row) {
    await row.click();
    const header = page.locator('.extension-editor .header');
    await waitUntil(async () => {
        const text = await header.innerText().catch(() => '');
        return text.startsWith('View Patch') && /\bUninstall\b/.test(text);
    }, UI_TIMEOUT, 'The View Patch details do not show it installed: they offer no Uninstall.');
    return header;
}

async function detailsVersion(page) {
    const details = page.locator('.extension-editor .additional-details-container, .extension-editor .more-info');
    const text = await details.first().innerText().catch(() => '');
    return /\bVersion\s+(\S+)/.exec(text)?.[1] ?? 'unknown';
}

async function dialogText(dialog) {
    return dialog.evaluate(box => ({
        message: box.querySelector('.dialog-message-text')?.textContent.trim() ?? '',
        detail: box.querySelector('.dialog-message-detail')?.textContent.trim() ?? '',
    })).catch(() => ({ message: '', detail: '' }));
}

/** Presses Cancel, or Escape, on each dialog that shows within `timeout`. It never chooses Allow or Sign in. */
async function cancelDialogs(page, timeout = 10 * SECOND) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const dialog = page.locator('.monaco-dialog-box:visible').first();
        if (await dialog.count() > 0) {
            const cancel = dialog.locator('.monaco-button', { hasText: /^Cancel$/ });
            if (await cancel.count() > 0) {
                await cancel.first().click().catch(() => {});
            } else {
                await page.keyboard.press('Escape');
            }
            await dialog.waitFor({ state: 'detached', timeout: 5 * SECOND }).catch(() => {});
        } else {
            await sleep(500);
        }
    }
}

/**
 * Opens the step 6 address and tells whether vscode.dev is signed in to GitHub: signed in when the patch shows in
 * the active editor and no sign-in prompt has appeared for SIGN_IN_QUIET; not signed in at the first prompt. Opening
 * the repository now and then stalls with neither, so the page reloads once after GITHUB_STALL.
 */
export async function openGitHubPatch(page) {
    const since = Date.now();
    let loaded = since;
    let reloaded = false;
    await load(page, GITHUB_PATCH_URL);
    for (;;) {
        const prompt = await signInPrompt(page, loaded);
        const seconds = Math.round((Date.now() - since) / SECOND);
        if (prompt) {
            return { signedIn: false, prompt, seconds, reloaded };
        }
        if (Date.now() - loaded >= SIGN_IN_QUIET && await patchShown(page)) {
            return { signedIn: true, seconds, reloaded };
        }
        if (Date.now() - since >= GITHUB_TIMEOUT) {
            throw new Error(`${GITHUB_PATCH_URL} showed neither ${PATCH_NAME} nor a sign-in prompt within`
                + ` ${GITHUB_TIMEOUT / MINUTE} minutes${reloaded ? ', with one reload' : ''}.`);
        }
        if (!reloaded && Date.now() - loaded >= GITHUB_STALL) {
            reloaded = true;
            loaded = Date.now();
            await load(page);
        } else {
            await sleep(500);
        }
    }
}

/** How long openGitHubPatch waited, for messages: "after 8 s", or "after 75 s and a reload". */
function waited(opened) {
    return `after ${opened.seconds} s${opened.reloaded ? ' and a reload' : ''}`;
}

async function signInPrompt(page, since) {
    const event = (await uiEvents(page, since)).find(entry => SIGN_IN_TEXT.test(entry.text)
        || entry.buttons.some(button => SIGN_IN_BUTTON.test(button)));
    if (event) {
        return event.text;
    }
    const button = page.locator('.part.sidebar .welcome-view-content .monaco-button:visible', {
        hasText: SIGN_IN_BUTTON,
    });
    return await button.count() > 0 ? `a ${(await button.first().innerText()).trim()} button` : undefined;
}

/** Whether the active editor is the step 6 patch with its text shown, rather than a review of it. */
async function patchShown(page) {
    return page.evaluate(name => {
        const tab = [...document.querySelectorAll('.tabs-container .tab.active')].find(element => {
            const label = element.getAttribute('aria-label') ?? '';
            return label.startsWith(name) && !label.includes('[Patch');
        });
        const lines = tab?.closest('.editor-group-container')?.querySelector('.editor-container .view-lines');
        return (lines?.textContent ?? '').replace(/\u00a0/g, ' ').includes('diff --git');
    }, PATCH_NAME).catch(() => false);
}

async function writeClipboard(page, text) {
    await page.bringToFront();
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
}

async function readClipboard(page) {
    await page.bringToFront();
    return page.evaluate(() => navigator.clipboard.readText());
}

/** The notifications and dialogs that pageHooks recorded from `since` on. */
async function uiEvents(page, since) {
    const events = await page.evaluate(() => globalThis.__viewPatchCheck?.events ?? []).catch(() => []);
    return events.filter(event => event.time >= since);
}

/** Every dialog, and each warning or error about View Patch or a missing Git repository. */
function problems(events) {
    return events.filter(event => event.kind === 'dialog' || NO_REPOSITORY.test(event.text)
        || (event.severity !== 'info' && /View Patch/.test(event.text)));
}

function describeEvent(event) {
    return `it showed the ${event.severity} ${event.kind} "${event.text}"`;
}

function reviewsPane(page) {
    return page.locator('.part.sidebar .pane', { has: page.locator('.pane-header', { hasText: 'Patch Reviews' }) });
}

async function showReviews(page) {
    const header = reviewsPane(page).locator('.pane-header');
    for (let attempt = 1; !await header.isVisible(); attempt += 1) {
        if (attempt > 3) {
            throw new Error('View Patch: Show Patch Reviews did not show the Patch Reviews view.');
        }
        await runCommand(page, 'View Patch: Show Patch Reviews');
        await visibleWithin(header, 15 * SECOND);
    }
    // The review tree draws only the rows that fit, so the other Explorer sections are collapsed.
    const sections = page.locator('.part.sidebar .pane-header:visible');
    for (let index = 0; index < await sections.count(); index += 1) {
        const section = sections.nth(index);
        const reviews = (await section.innerText()).includes('Patch Reviews');
        if ((await section.getAttribute('aria-expanded') === 'true') !== reviews) {
            await section.click();
        }
    }
}

/** The reviews that Patch Reviews lists, each with its file rows, from the rows' accessible labels. */
async function reviewTree(page) {
    const rows = await reviewsPane(page).locator('.monaco-list-row').evaluateAll(elements => elements.map(row => ({
        index: Number(row.dataset.index ?? 0),
        level: Number(row.getAttribute('aria-level') ?? 1),
        label: row.getAttribute('aria-label') ?? row.textContent.trim(),
    })));
    const reviews = [];
    for (const row of rows.sort((a, b) => a.index - b.index)) {
        if (row.level === 1) {
            reviews.push({ name: row.label.split(', ')[0], label: row.label, files: [] });
        } else if (reviews.length > 0 && FILE_ROW.test(row.label)) {
            reviews.at(-1).files.push({ name: row.label.split(', ')[0], label: row.label });
        }
    }
    return reviews;
}

async function waitForReview(page, accept, what) {
    let reviews = [];
    const review = await poll(async () => {
        reviews = await reviewTree(page);
        return reviews.find(accept);
    }, UI_TIMEOUT);
    if (!review) {
        const listed = reviews.map(entry => `\`${entry.label}\` (${quoted(entry.files.map(file => file.name))})`);
        throw new Error(`${what} did not appear in Patch Reviews within ${UI_TIMEOUT / SECOND} s; it lists`
            + ` ${listed.join('; ') || 'no review'}.`);
    }
    return review;
}

function fileRow(page, fileName) {
    return reviewsPane(page).locator(`.monaco-list-row[aria-label^=${JSON.stringify(`${fileName}, `)}]`).first();
}

function isReviewed(label) {
    return /, reviewed(?:,|$)/.test(label ?? '');
}

/** Clicks the row's inline Toggle Reviewed action, then waits for its label to say `reviewed` or not. */
async function toggleReviewed(page, fileName, reviewed) {
    const row = fileRow(page, fileName);
    await row.hover();
    await row.locator('.actions .action-label[aria-label^="Toggle Reviewed"]').click();
    const label = await poll(async () => {
        const current = await row.getAttribute('aria-label');
        return isReviewed(current) === reviewed ? current : undefined;
    }, 30 * SECOND);
    if (!label) {
        throw new Error(`Toggle Reviewed left \`${fileName}\` as \`${await row.getAttribute('aria-label')}\`.`);
    }
    return label;
}

/** Marks a file reviewed. A profile used before may restore the mark; then the run clears it and sets it again. */
async function markReviewed(page, fileName) {
    const before = await fileRow(page, fileName).getAttribute('aria-label');
    const cleared = isReviewed(before);
    if (cleared) {
        await toggleReviewed(page, fileName, false);
    }
    return { before, after: await toggleReviewed(page, fileName, true), cleared };
}

async function contextMenu(page, row) {
    await row.click({ button: 'right' });
    const menu = page.locator('.context-view .monaco-menu');
    await menu.waitFor({ timeout: UI_TIMEOUT });
    const items = await menu.locator('.action-item').evaluateAll(elements => elements.map(item => ({
        text: item.querySelector('.action-label')?.textContent.trim() ?? '',
        disabled: item.classList.contains('disabled'),
    })).filter(item => item.text));
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: 10 * SECOND }).catch(() => {});
    return items;
}

/** Chooses the step 6 patch in Reopen Recent Patch...: its GitHub copy, or for the substitute, its private copy. */
async function pickRecent(page, substitute) {
    const rows = page.locator('.quick-input-widget .monaco-list-row');
    const items = await poll(async () => {
        const listed = await rows.evaluateAll(elements => elements.map(row => ({
            index: row.dataset.index,
            label: row.querySelector('.label-name')?.textContent.trim() ?? '',
            description: row.querySelector('.label-description')?.textContent.trim() ?? '',
            detail: row.innerText.split('\n').slice(1).map(line => line.trim()).filter(Boolean).join(' '),
        })));
        return listed.some(item => item.label === PATCH_NAME) ? listed : undefined;
    }, UI_TIMEOUT);
    if (!items) {
        throw new Error(`Reopen Recent Patch... does not list ${PATCH_NAME}.`);
    }
    // A profile used before may list both copies.
    const choice = items.find(item => item.label === PATCH_NAME && item.detail.includes('vcpkg') !== substitute);
    if (!choice) {
        const listed = items.map(item => `${item.label} (${item.detail})`);
        throw new Error(`Reopen Recent Patch... lists ${quoted(listed)}, but not the`
            + ` ${substitute ? 'private-storage' : 'GitHub'} copy of ${PATCH_NAME}.`);
    }
    await page.locator(`.quick-input-widget .monaco-list-row[data-index="${choice.index}"]`).click();
    return choice;
}

async function outputPanel(page) {
    return page.evaluate(() => {
        const panel = document.querySelector('.part.panel');
        const select = panel?.querySelector('select[aria-label="Switch Output"]');
        return {
            view: panel?.querySelector('.composite.title .action-item.checked')?.textContent.trim() ?? '',
            channel: select?.options[select.selectedIndex]?.text ?? '',
        };
    }).catch(() => ({ view: '', channel: '' }));
}

/** The View Patch output channel's text, copied whole, since the editor draws only the lines that fit. */
async function viewPatchOutput(page) {
    await runCommand(page, 'View Patch: Show View Patch Output');
    if (!await poll(async () => (await outputPanel(page)).channel === 'View Patch', 30 * SECOND)) {
        throw new Error('Show View Patch Output did not select the View Patch output channel');
    }
    const lines = page.locator('.part.panel .output-view .monaco-editor .view-lines').first();
    await writeClipboard(page, CLIPBOARD_SENTINEL);
    await lines.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+C');
    const copied = await poll(async () => {
        const text = await readClipboard(page);
        return text !== CLIPBOARD_SENTINEL ? text : undefined;
    }, 5 * SECOND);
    return copied ?? lines.evaluate(element => [...element.querySelectorAll('.view-line')]
        .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
        .map(line => line.textContent.replace(/\u00a0/g, ' ')).join('\n'));
}

async function browserVersion(context, page) {
    const version = context.browser()?.version();
    if (version) {
        return version;
    }
    const cdp = await context.newCDPSession(page);
    try {
        return (await cdp.send('Browser.getVersion')).product.split('/').pop();
    } finally {
        await cdp.detach().catch(() => {});
    }
}

/** Calls `probe` until it returns a truthy value, which it returns, or until `timeout` ends, returning undefined. */
async function poll(probe, timeout, interval = 500) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await probe();
        if (value) {
            return value;
        }
        if (Date.now() >= deadline) {
            return undefined;
        }
        await sleep(interval);
    }
}

async function waitUntil(probe, timeout, message) {
    if (!await poll(probe, timeout)) {
        throw new Error(message);
    }
}

async function visibleWithin(locator, timeout) {
    return locator.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}

function exactly(text) {
    return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

function quoted(values) {
    return values.length > 0 ? values.map(value => `\`${value}\``).join(', ') : 'nothing';
}

function count(value) {
    return value.toLocaleString('en-US');
}

function isOrigin(value, origin) {
    try {
        return new URL(value).origin === origin;
    } catch {
        return false;
    }
}

async function loadSignInState(file) {
    try {
        return decodeState(await readFile(file, 'utf8'));
    } catch (error) {
        throw new UsageError(`--sign-in-state ${file} cannot be used: ${errorText(error)}.`);
    }
}

/** The interactive helper: waits for a person to sign in to GitHub in the profile, then optionally saves it. */
async function signIn({ profile, saveSignInState: file, timeoutMinutes }) {
    let session;
    let state;
    const minutes = `${timeoutMinutes} minute${timeoutMinutes === 1 ? '' : 's'}`;
    try {
        session = await openSession({ profile, headed: true, automated: false });
        await session.page.goto(GITHUB_PATCH_URL, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT });
        console.log([
            `Chromium is open on ${GITHUB_PATCH_URL}, with the profile ${profile}.`,
            'In that window, sign in to GitHub: choose Allow when vscode.dev says that GitHub Repositories wants to',
            'sign in, finish signing in on github.com, and allow GitHub Repositories to use the account if it asks.',
            `Waiting up to ${minutes} for ${PATCH_NAME} to open in an editor tab...`,
        ].join('\n'));
        const result = await poll(async () => {
            if (session.page.isClosed()) {
                return 'closed';
            }
            return await patchShown(session.page) ? 'signed in' : undefined;
        }, timeoutMinutes * MINUTE, SECOND);
        if (result !== 'signed in') {
            console.error(interrupted || result === 'closed'
                ? 'The browser closed before the sign-in finished. Nothing was saved.'
                : `No sign-in within ${minutes}: ${PATCH_NAME} never opened in an editor tab. Nothing was saved;`
                    + ' run --sign-in again and finish signing in in the browser window.');
            return interrupted ? INTERRUPTED : EXIT.incomplete;
        }
        console.log(`Signed in: ${PATCH_NAME} opened from GitHub, and the profile keeps the sign-in.`);
        if (file) {
            state = await session.context.storageState({ indexedDB: true });
        }
    } catch (error) {
        console.error(`The sign-in helper failed: ${errorText(error)}`);
        return interrupted ? INTERRUPTED : EXIT.fail;
    } finally {
        await session?.close();
    }
    return state ? saveSignInState(state, file) : EXIT.pass;
}

/** Opens the step 6 address in a new headless browser started from `state`, and tells whether it is signed in. */
export async function verifySignInState(state) {
    let session;
    try {
        session = await openSession({ signInState: state });
        const opened = await openGitHubPatch(session.page);
        if (!opened.signedIn) {
            const detail = `vscode.dev is not signed in: ${waited(opened)}, it showed "${opened.prompt}"`;
            return { ok: false, detail };
        }
        return { ok: true, detail: `${PATCH_NAME} opened with no sign-in prompt ${waited(opened)}` };
    } catch (error) {
        return { ok: false, detail: errorText(error) };
    } finally {
        await session?.close();
    }
}

/**
 * Saves a sign-in state for runs elsewhere: the smallest variant with which a new browser is signed in, trying the
 * trimmed state with only vscode.dev's cookies, then with every cookie, then the full state. It writes <file> (JSON)
 * and <file>.b64 (encodeState), plus <file>.b64.1 and on when one secret cannot hold it, all with mode 0600. Saves
 * nothing, and returns EXIT.fail, if no variant works. `verify` is for tests.
 */
export async function saveSignInState(state, file, { verify = verifySignInState } = {}) {
    const variants = [];
    for (const [variant, candidate] of [
        ['trimmed', trimStorageState(state)],
        ['trimmed, with every cookie', trimStorageState(state, { everyCookie: true })],
        ['full', state],
    ]) {
        if (!variants.some(([, earlier]) => JSON.stringify(earlier) === JSON.stringify(candidate))) {
            variants.push([variant, candidate]);
        }
    }
    for (const [variant, candidate] of variants) {
        console.log(`Checking the ${variant} sign-in state in a new headless browser...`);
        const result = await verify(candidate);
        if (!result.ok) {
            console.log(`The ${variant} state did not work: ${result.detail.replace(/\.$/, '')}.`);
            continue;
        }
        const json = JSON.stringify(candidate);
        const encoded = encodeState(json);
        let pieces;
        try {
            pieces = splitSecret(encoded);
        } catch (error) {
            console.error(`${errorText(error)} Nothing was saved.`);
            return EXIT.fail;
        }
        await writePrivate(file, json);
        await writePrivate(`${file}.b64`, encoded);
        for (let index = 1; index <= SECRET_PIECES; index += 1) {
            const piece = `${file}.b64.${index}`;
            await (pieces.length > 1 && index <= pieces.length
                ? writePrivate(piece, pieces[index - 1])
                : rm(piece, { force: true }));
        }
        const lines = [
            `Saved the ${variant} sign-in state: a new headless browser opened ${PATCH_NAME} with it, and no sign-in`
                + ' prompt.',
            `  ${file}: ${count(Buffer.byteLength(json))} bytes of JSON`,
        ];
        if (pieces.length === 1) {
            lines.push(`  ${file}.b64: ${count(encoded.length)} characters (gzip, then base64), for the secret`
                + ` ${secretName(0)}`);
        } else {
            lines.push(`  ${file}.b64: ${count(encoded.length)} characters (gzip, then base64), more than one secret`
                + ` holds (${count(SECRET_LIMIT)}), so it is also split into pieces for these secrets, which the`
                + ' workflow joins in this order:');
            pieces.forEach((piece, index) => lines.push(
                `    ${file}.b64.${index + 1}: ${count(piece.length)} characters, for ${secretName(index)}`));
        }
        const domains = cookieDomains(candidate);
        const cookies = domains.length > 0 ? `, and the browser's cookies for ${domains.join(', ')}` : '';
        lines.push('Warning: these files are a credential. They hold a GitHub token for the signed-in account'
            + `${cookies}. Keep them private (they have mode 0600), and never commit them.`);
        if (domains.some(domain => domain === 'github.com' || domain.endsWith('.github.com'))) {
            lines.push('They include a github.com web session too: anyone who reads them can use github.com as that'
                + ' account. To revoke it, sign that session out under the account\'s Settings > Sessions.');
        }
        console.log(lines.join('\n'));
        return EXIT.pass;
    }
    console.error('Nothing was saved: no variant of the sign-in state opened the patch without a sign-in prompt.');
    return EXIT.fail;
}

async function writePrivate(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, 'w', 0o600);
    try {
        // `open` sets the mode only when it creates the file.
        await handle.chmod(0o600);
        await handle.writeFile(text);
    } finally {
        await handle.close();
    }
}

/** Closes every browser on the first SIGINT, SIGTERM, or SIGHUP, so that the run can finish; exits on the second. */
function handleSignals() {
    let signals = 0;
    const handler = signal => {
        interrupted = true;
        signals += 1;
        if (signals > 1) {
            process.exit(INTERRUPTED);
        }
        console.error(`${signal}: closing the browser.`);
        for (const session of sessions) {
            void session.close();
        }
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, handler);
    }
}

async function main(args) {
    let options;
    try {
        options = parseOptions(args);
        if (options.signInState) {
            options.signInState = await loadSignInState(options.signInState);
        }
    } catch (error) {
        if (!(error instanceof UsageError)) {
            throw error;
        }
        console.error(`${error.message}\n\n${USAGE}`);
        return EXIT.usage;
    }
    if (options.help) {
        console.log(USAGE);
        return EXIT.pass;
    }
    handleSignals();
    return options.signIn ? signIn(options) : new CheckRun(options).run();
}

function isMain() {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMain()) {
    process.exitCode = await main(process.argv.slice(2));
}
