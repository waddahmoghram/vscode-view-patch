import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// The release-check scripts are plain JavaScript; these tests treat their results as loosely typed data.
type Json = any;

const scripts = path.join(__dirname, '..', '..', '..', 'scripts', 'release-checks');
const loadReport = (): Promise<Json> => import(pathToFileURL(path.join(scripts, 'report.mjs')).href);
const loadExit = (): Promise<Json> => import(pathToFileURL(path.join(scripts, 'exit.mjs')).href);
const loadWeb = (): Promise<Json> => import(pathToFileURL(path.join(scripts, 'web.mjs')).href);

// Runs `task` with console output captured in `printed` instead of shown: the scripts print each step, and a FAIL
// line, or a workflow command when GitHub Actions runs the tests, would read as a CI failure.
async function quietly<T>(task: () => T | Promise<T>, printed: string[] = []): Promise<T> {
    const { log, error } = console;
    console.log = (...values: unknown[]) => void printed.push(values.join(' '));
    console.error = (...values: unknown[]) => void printed.push(values.join(' '));
    try {
        return await task();
    } finally {
        console.log = log;
        console.error = error;
    }
}

const API = 'https://api.github.com/repos/o/r';
const QUERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const VSPACKAGE = 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/waddahmoghram/vsextensions/'
    + 'view-patch/1.2.3/vspackage';
const ASSET_URL = 'https://github.com/o/r/releases/download/v1.2.3/view-patch.vsix';
const PACKAGE = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('a package')]);
const DIGEST = createHash('sha256').update(PACKAGE).digest('hex');
const MANIFEST = '<PackageManifest><Metadata><Identity Language="en-US" Id="view-patch" Version="1.2.3" '
    + 'Publisher="waddahmoghram" /></Metadata></PackageManifest>';

interface Sent {
    url: string;
    headers: Record<string, string>;
}

const json = (body: Json) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function listing(versions: string[]): Json {
    return {
        results: [{
            extensions: [{
                versions: versions.map(version => ({
                    version,
                    flags: 'validated',
                    lastUpdated: '2026-11-26T21:44:21Z',
                    properties: [{ key: 'Microsoft.VisualStudio.Services.VsixSha256', value: DIGEST.toUpperCase() }],
                })),
            }],
        }],
    };
}

// The GitHub, release, and Marketplace answers for a tag run of 1.2.3 whose every digest is DIGEST.
function routes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
    return {
        [`${API}/actions/runs/7`]: () => json({
            id: 7, path: '.github/workflows/publish.yml', status: 'completed', conclusion: 'success', event: 'push',
            head_branch: 'v1.2.3', head_sha: '889b167dfd1f', run_attempt: 1,
        }),
        [`${API}/actions/runs/7/jobs?per_page=100`]: () => json({
            jobs: [
                { id: 11, name: 'verify / package', status: 'completed', conclusion: 'success' },
                { id: 12, name: 'publish', status: 'completed', conclusion: 'success' },
                { id: 13, name: 'open-vsx', status: 'completed', conclusion: 'skipped' },
            ],
        }),
        [`${API}/actions/jobs/11/logs`]: () => new Response(
            `2026-11-26T21:37:00.0000000Z Packaged view-patch.vsix (regular), SHA-256 ${DIGEST}\n`),
        [`${API}/actions/jobs/12/logs`]: () => new Response([
            `2026-11-26T21:39:00.0000000Z Publishing view-patch.vsix (regular), SHA-256 ${DIGEST}`,
            '2026-11-26T21:40:00.0000000Z  DONE  Published waddahmoghram.view-patch v1.2.3.',
            '',
        ].join('\n')),
        [`${API}/releases/tags/v1.2.3`]: () => json({
            draft: false, prerelease: false, published_at: '2026-11-26T21:40:15Z',
            body: `Changes.\n\nPackage SHA-256: \`${DIGEST}\``,
            assets: [{
                name: 'view-patch.vsix',
                size: PACKAGE.length,
                digest: `sha256:${DIGEST}`,
                browser_download_url: ASSET_URL,
            }],
        }),
        [ASSET_URL]: () => new Response(PACKAGE),
        [QUERY]: () => json(listing(['1.2.3', '1.2.2'])),
        [VSPACKAGE]: () => new Response(PACKAGE),
        ...overrides,
    };
}

function fakeFetch(answers: Record<string, () => Response>, sent: Sent[]) {
    return async (url: string, init: Json = {}) => {
        sent.push({ url, headers: init.headers ?? {} });
        const answer = answers[url];
        return answer ? answer() : new Response('Not Found', { status: 404 });
    };
}

async function verify(options: Json, answers = routes(), sent: Sent[] = []): Promise<Json> {
    const { verifyRelease } = await loadExit();
    return verifyRelease({
        repository: 'o/r', fetch: fakeFetch(answers, sent), readManifest: async () => MANIFEST,
        sleep: async () => undefined, ...options,
    });
}

const outcomes = (report: Json): string[][] => report.steps.map((step: Json) => [step.id, step.status]);

describe('release check reports', () => {
    test('rank a failed step over a step not run, and either over a substitute', async () => {
        const { CheckReport, EXIT } = await loadReport();
        const make = (...statuses: string[]) => {
            const report = new CheckReport({ check: 'X', title: 'Check X' });
            statuses.forEach((status, index) => report[status](String(index + 1), 'step', 'detail'));
            return report.verdict();
        };
        assert.deepEqual([make('pass', 'substitute', 'notRun', 'fail').verdict, make('substitute', 'notRun').verdict,
            make('pass', 'substitute').verdict, make('pass').verdict, make().verdict],
        ['fail', 'incomplete', 'pass with substitutes', 'pass', 'incomplete']);
        assert.deepEqual([make('fail').exitCode, make('notRun').exitCode, make('substitute').exitCode],
            [EXIT.fail, EXIT.incomplete, EXIT.pass]);
    });

    test('write a Markdown table that survives pipes and newlines, and fence evidence past its backticks', async () => {
        const { CheckReport } = await loadReport();
        const report = new CheckReport({ check: 'X', title: 'Check X', target: { 'View Patch': '1.2.3' } });
        await report.run('1', 'Copy', async () => 'a | b\nc');
        await report.run('2', 'Throw', async () => {
            throw new Error('went wrong');
        });
        report.attach('Log', 'before ```` after');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'view-patch-report-'));
        const summary = path.join(out, 'summary.md');
        const previous = { summary: process.env.GITHUB_STEP_SUMMARY, actions: process.env.GITHUB_ACTIONS };
        const restore = (name: string, value: string | undefined) => {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        };
        const printed: string[] = [];
        process.env.GITHUB_STEP_SUMMARY = summary;
        process.env.GITHUB_ACTIONS = 'true';
        try {
            assert.equal(await quietly(() => report.write(out), printed), 1);
        } finally {
            restore('GITHUB_STEP_SUMMARY', previous.summary);
            restore('GITHUB_ACTIONS', previous.actions);
        }
        assert.ok(printed.includes('::error title=Check X%3A 2. Throw::went wrong'), printed.join('\n'));
        const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
        assert.match(markdown, /^### Check X: FAIL \(1 step failed\)$/m);
        assert.match(markdown, /^\| 1\. Copy \| PASS \| a \\\| b c \|$/m);
        assert.match(markdown, /^\| 2\. Throw \| FAIL \| went wrong \|$/m);
        assert.match(markdown, /^`````text\nbefore ```` after\n`````$/m);
        assert.equal(fs.readFileSync(summary, 'utf8'), markdown);
        assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).verdict, 'fail');
        fs.rmSync(out, { recursive: true, force: true });
    });

    test('annotate a failed step, escaped as a workflow command, or else the steps that did not run', async () => {
        const { CheckReport } = await loadReport();
        const failing = new CheckReport({ check: 'A', title: 'Check A' });
        failing.pass('package', 'Package identity', 'fine');
        failing.fail('editor', 'VS Code, local', 'ENOENT: no such file\n100% missing');
        failing.notRun('1', 'Identity gate', 'there is no VS Code test instance');
        assert.deepEqual(failing.annotations(),
            ['::error title=Check A%3A editor. VS Code%2C local::ENOENT: no such file%0A100%25 missing']);
        const incomplete = new CheckReport({ check: 'exit', title: 'Exit' });
        incomplete.pass('1', 'Publish run', 'fine');
        incomplete.notRun('2', 'Job digests', 'no token');
        assert.deepEqual(incomplete.annotations(),
            ['::warning title=Exit%3A 1 step not run::2. Job digests: no token']);
        const passing = new CheckReport({ check: 'B', title: 'Check B' });
        passing.substitute('6', 'GitHub patch', 'a copy');
        assert.deepEqual(passing.annotations(), []);
    });
});

describe('release check A', () => {
    test('finds VS Code\'s files beside the executable, or in the commit-named folder of a Windows archive',
        async () => {
            const { vscodeAppFolder } = await import(pathToFileURL(path.join(scripts, 'hosts.mjs')).href);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-patch-vscode-'));
            const app = (...parts: string[]) => {
                const folder = path.join(dir, ...parts, 'resources', 'app');
                fs.mkdirSync(folder, { recursive: true });
                fs.writeFileSync(path.join(folder, 'package.json'), '{}');
                return folder;
            };
            try {
                const executable = path.join(dir, 'Code.exe');
                fs.mkdirSync(path.join(dir, 'bin'));
                assert.throws(() => vscodeAppFolder(executable, 'win32'), /found 0 such folders/);
                const versioned = app('661626d0e7');
                assert.equal(vscodeAppFolder(executable, 'win32'), versioned);
                app('0123456789');
                assert.throws(() => vscodeAppFolder(executable, 'win32'), /found 2 such folders/);
                const flat = app();
                assert.equal(vscodeAppFolder(executable, 'win32'), flat);
                assert.equal(vscodeAppFolder(path.join(dir, 'code'), 'linux'), flat);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
});

describe('release exit verification', () => {
    test('passes a tag run whose job, release, and Marketplace digests agree, sending the token only to the API',
        async () => {
            const sent: Sent[] = [];
            const { report, settled } = await verify({ runId: '7', token: 'secret-token' }, routes(), sent);
            assert.deepEqual(outcomes(report), [['1', 'pass'], ['2', 'pass'], ['2a', 'pass'], ['3', 'pass'],
                ['4', 'pass'], ['5', 'pass'], ['6', 'pass']]);
            assert.deepEqual(settled, {
                version: '1.2.3', channel: 'regular', tag: 'v1.2.3', sha256: DIGEST,
                versionSources: ['tag v1.2.3', 'vsce in the publish job'],
                channelSources: ['tag v1.2.3', 'the job digests'],
            });
            assert.equal(report.steps.at(-1).detail, `7 digests agree: ${DIGEST}`);
            const authorized = sent.filter(request => 'Authorization' in request.headers).map(request => request.url);
            assert.ok(authorized.length > 0 && authorized.every(url => url.startsWith(API)), authorized.join(', '));
        });

    test('fails when the Marketplace download differs from the package the publish job uploaded', async () => {
        const tampered = Buffer.concat([PACKAGE, Buffer.from('!')]);
        const { report } = await verify({ runId: '7', token: 'secret-token' },
            routes({ [VSPACKAGE]: () => new Response(tampered) }));
        assert.equal(report.verdict().verdict, 'fail');
        const agreement = report.steps.find((step: Json) => step.id === '6');
        assert.equal(agreement.status, 'fail');
        assert.match(agreement.detail, /^Marketplace download \(\w+…\w+\) differs from the Marketplace publish job/);
    });

    test('leaves the job digests not run without a token, so the verdict is incomplete', async () => {
        const sent: Sent[] = [];
        const { report } = await verify({ runId: '7' }, routes(), sent);
        assert.deepEqual(outcomes(report).find(([id]) => id === '2'), ['2', 'not run']);
        assert.equal(report.verdict().exitCode, 3);
        assert.equal(sent.some(request => request.url.endsWith('/logs')), false);
        assert.equal(report.steps.at(-1).detail, `5 digests agree: ${DIGEST}`);
    });

    test('polls until the Marketplace lists the version, and fails when the channels disagree', async () => {
        let queries = 0;
        let clock = 0;
        const { report } = await verify({ version: '1.2.3', channel: 'regular', waitMinutes: 5, pollMs: 60_000,
            now: () => clock, sleep: async (ms: number) => {
                clock += ms;
            } }, routes({ [QUERY]: () => json(listing(++queries < 3 ? ['1.2.2'] : ['1.2.3', '1.2.2'])) }));
        assert.equal(queries, 3);
        assert.deepEqual(outcomes(report).slice(1), [['2a', 'pass'], ['4', 'pass'], ['5', 'pass'], ['6', 'pass']]);

        const { report: wrong } = await verify({ runId: '7', token: 'secret-token', channel: 'pre-release' });
        const settle = wrong.steps.find((step: Json) => step.id === '2a');
        assert.equal(settle.status, 'fail');
        assert.match(settle.detail,
            /the channel differs: --version and --channel says pre-release, tag v1\.2\.3 says regular/);
    });
});

// A Playwright storage state as vscode.dev leaves it, cut down to what the trim rules look at.
const SIGN_IN_STATE = {
    cookies: [
        { name: 'key', value: '1', domain: 'vscode.dev' },
        { name: 'dot', value: '2', domain: '.vscode.dev' },
        { name: 'user_session', value: '3', domain: 'github.com' },
        { name: 'MC1', value: '4', domain: '.microsoft.com' },
        { name: 'lookalike', value: '5', domain: 'notvscode.dev' },
    ],
    origins: [
        {
            origin: 'https://vscode.dev',
            localStorage: [{ name: 'secrets', value: 'encrypted' }],
            indexedDB: [
                { name: 'vscode-web-db', version: 3, stores: [{ name: 'vscode-userdata-store', records: [] }] },
                {
                    name: 'vscode-web-state-db-global',
                    version: 1,
                    stores: [{
                        name: 'ItemTable',
                        records: [
                            { key: 'additionalBuiltinExtensions', value: '[]' },
                            { key: 'github.auth', value: 'x' },
                        ],
                    }],
                },
                { name: 'vscode-web-state-db-46d60ba3', version: 1, stores: [{ name: 'ItemTable', records: [] }] },
            ],
        },
        { origin: 'https://v--abc.vscode-cdn.net', localStorage: [], indexedDB: [{ name: 'anycode', stores: [] }] },
    ],
};

describe('release check sign-in state', () => {
    test('keeps only vscode.dev cookies, local storage, and the global state without its built-in extension list',
        async () => {
            const { trimStorageState } = await loadWeb();
            const trimmed = trimStorageState(SIGN_IN_STATE);
            assert.deepEqual(trimmed.cookies.map((cookie: Json) => cookie.name), ['key', 'dot']);
            assert.deepEqual(trimmed.origins.map((entry: Json) =>
                [entry.origin, entry.localStorage.length, entry.indexedDB.map((database: Json) => database.name)]),
            [['https://vscode.dev', 1, ['vscode-web-state-db-global']]]);
            assert.deepEqual(trimmed.origins[0].indexedDB[0].stores[0].records.map((record: Json) => record.key),
                ['github.auth']);
            assert.equal(trimStorageState(SIGN_IN_STATE, { everyCookie: true }).cookies.length, 5);
        });

    test('reads the JSON and its gzip, then base64, form, and splits that among at most four secrets', async () => {
        const { decodeState, encodeState, secretName, splitSecret } = await loadWeb();
        const encoded = encodeState(SIGN_IN_STATE);
        assert.deepEqual(decodeState(`${encoded.slice(0, 20)}\n${encoded.slice(20)}\n`), SIGN_IN_STATE);
        assert.deepEqual(decodeState(JSON.stringify(SIGN_IN_STATE)), SIGN_IN_STATE);
        assert.throws(() => decodeState('{"cookies": []}'), /not a Playwright storage state/);
        const long = 'x'.repeat(100_000);
        assert.deepEqual(splitSecret(long).map((piece: string) => piece.length), [45_000, 45_000, 10_000]);
        assert.equal(splitSecret(long).join(''), long);
        assert.deepEqual(splitSecret(encoded), [encoded]);
        assert.throws(() => splitSecret('x'.repeat(4 * 45_000 + 1)), /more than the 4 that the workflow joins/);
        assert.deepEqual([0, 1, 3].map(secretName),
            ['VSCODE_DEV_SIGN_IN_STATE', 'VSCODE_DEV_SIGN_IN_STATE_2', 'VSCODE_DEV_SIGN_IN_STATE_4']);
    });

    test('saves the smallest variant that a new browser is signed in with, privately, and nothing when none is',
        async () => {
            const { decodeState, saveSignInState } = await loadWeb();
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-patch-sign-in-'));
            const file = path.join(dir, 'state.json');
            const tried: number[] = [];
            const needsGitHub = async (candidate: Json) => {
                tried.push(candidate.cookies.length);
                const ok = candidate.cookies.some((cookie: Json) => cookie.domain === 'github.com');
                return { ok, detail: 'not signed in' };
            };
            try {
                assert.equal(await quietly(() => saveSignInState(SIGN_IN_STATE, file, { verify: needsGitHub })), 0);
                assert.deepEqual(tried, [2, 5]);
                const saved = decodeState(fs.readFileSync(`${file}.b64`, 'utf8'));
                assert.equal(saved.origins[0].indexedDB.length, 1, 'the every-cookie variant is still trimmed');
                assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);
                if (process.platform !== 'win32') {
                    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
                    assert.equal(fs.statSync(`${file}.b64`).mode & 0o777, 0o600);
                }
                const none = path.join(dir, 'none.json');
                const never = async () => ({ ok: false, detail: 'not signed in' });
                assert.equal(await quietly(() => saveSignInState(SIGN_IN_STATE, none, { verify: never })), 1);
                assert.equal(fs.existsSync(none) || fs.existsSync(`${none}.b64`), false);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
});
