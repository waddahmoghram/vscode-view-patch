import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// The script is plain JavaScript; these tests treat its results as loosely typed data.
type Json = any;

interface Dashboard {
    RULES: Record<string, string>;
    parseNodeTestSummaries(text: string): Json[];
    parseMochaSummary(text: string): Json;
    parseDigestLines(text: string): Json;
    testCountsFromLog(jobName: string, text: string): Json;
    digestVerdict(recorded: Json, marketplace?: Json): Json;
    summarizeRuns(runs: Json[], options?: { publish?: boolean }): Json;
    parseMarketplace(body: Json): Json;
    parseOpenVsx(status: number, body: Json): Json;
    dependabotPulls(pulls: Json[], now: Date): Json[];
    readiness(report: Json): Json;
    renderHtml(report: Json): string;
    renderMarkdown(report: Json): string;
    collect(options: Json): Promise<Json>;
}

const script = path.join(__dirname, '..', '..', '..', 'scripts', 'quality-dashboard.mjs');
const load = (): Promise<Dashboard> => import(pathToFileURL(script).href);

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// GitHub prefixes every job log line with a timestamp.
const log = (...lines: string[]): string =>
    lines.map((line, index) => `2026-11-11T06:26:${String(10 + index).padStart(2, '0')}.1234567Z ${line}`).join('\n');

const UNIT_LOG = log(
    '##[group]Run npm run test:unit',
    'ℹ tests 334', 'ℹ suites 30', 'ℹ pass 334', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0',
    'ℹ duration_ms 5874.198095',
    '\u001b[34mℹ tests 334\u001b[39m', 'ℹ suites 30', 'ℹ pass 333', 'ℹ fail 1',
    '  56 passing (23s)',
    '  1 pending',
    'PASS: real Restricted Mode blocks Git-backed viewing and permits explicit hunk-only reviews.',
);

const WEB_LOG = log('  View Patch in the web extension host', '    ✅ activates and exposes the review controller',
    '  5 passing (2s)');

const PACKAGE_LOG = log(
    '##[group]Run npx vsce package ${PRE_RELEASE_FLAG:+"$PRE_RELEASE_FLAG"} --out view-patch.vsix',
    'Packaged: view-patch.vsix (23 files, 130.25 KB)',
    '##[group]Run channel=regular',
    'echo "Packaged view-patch.vsix (${channel}), SHA-256 ${digest}" | tee -a "${GITHUB_STEP_SUMMARY}"',
    '##[endgroup]',
    `Packaged view-patch.vsix (pre-release), SHA-256 ${DIGEST}`,
);

const PUBLISH_LOG = log(
    'echo "Publishing view-patch.vsix (${packaged}), SHA-256 ${digest}" | tee -a "${GITHUB_STEP_SUMMARY}"',
    `Publishing view-patch.vsix (pre-release), SHA-256 ${DIGEST}`,
    "Publishing 'waddahmoghram.view-patch v0.3.2'...",
    'Published waddahmoghram.view-patch v0.3.2.',
);

const OPEN_VSX_LOG = log(`Publishing view-patch.vsix to Open VSX, SHA-256 ${DIGEST}`);

function run(overrides: Json = {}): Json {
    return {
        id: 101,
        run_number: 8,
        run_attempt: 1,
        event: 'push',
        head_branch: 'main',
        head_sha: '84c7a7c07f5ee324597a5ec7c40b5f8b714a0165',
        display_title: 'Make the bug report form channel-neutral',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/o/r/actions/runs/101',
        created_at: '2026-11-11T06:00:00Z',
        run_started_at: '2026-11-11T06:00:00Z',
        updated_at: '2026-11-11T06:03:00Z',
        ...overrides,
    };
}

const MARKETPLACE = {
    results: [{
        extensions: [{
            lastUpdated: '2026-11-12T00:00:00Z',
            versions: [{
                version: '0.3.2',
                lastUpdated: '2026-11-12T00:00:00Z',
                properties: [
                    { key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' },
                    { key: 'Microsoft.VisualStudio.Services.VsixSha256', value: DIGEST },
                ],
            }],
            statistics: [
                { statisticName: 'install', value: 3 },
                { statisticName: 'downloadCount', value: 29 },
                { statisticName: 'updateCount', value: 1 },
                { statisticName: 'weightedRating', value: 4.4 },
            ],
        }],
    }],
};

describe('quality dashboard log parsing', () => {
    test('reads each node:test summary from a timestamped, colored job log', async () => {
        const { parseNodeTestSummaries } = await load();
        assert.deepEqual(parseNodeTestSummaries(UNIT_LOG), [
            { tests: 334, suites: 30, pass: 334, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
            { tests: 334, suites: 30, pass: 333, fail: 1 },
        ]);
        assert.deepEqual(parseNodeTestSummaries('# tests 12\n# pass 12\n# fail 0\n'), [{ tests: 12, pass: 12, fail: 0 }]);
        assert.deepEqual(parseNodeTestSummaries(log('ℹ pass 3', 'no summary here')), []);
    });

    test('reads the last Mocha summary with its failing and pending counts', async () => {
        const { parseMochaSummary } = await load();
        assert.deepEqual(parseMochaSummary(UNIT_LOG), { passing: 56, failing: 0, pending: 1 });
        assert.deepEqual(parseMochaSummary(log('  4 passing (2s)', '  54 passing (20s)', '  2 failing')),
            { passing: 54, failing: 2, pending: 0 });
        assert.equal(parseMochaSummary(log('  2 failing')), undefined);
    });

    test('finds package digests and the published version, not the echoed commands', async () => {
        const { parseDigestLines } = await load();
        assert.deepEqual(parseDigestLines([PACKAGE_LOG, PUBLISH_LOG, OPEN_VSX_LOG].join('\n')), {
            packaged: { channel: 'pre-release', sha256: DIGEST },
            publishing: { channel: 'pre-release', sha256: DIGEST },
            openVsx: { sha256: DIGEST },
            publishedVersion: '0.3.2',
        });
        assert.deepEqual(parseDigestLines(log('Packaged: view-patch.vsix (23 files, 130.25 KB)',
            'Packaged view-patch.vsix (pre-release), SHA-256 abc')), {});
    });

    test('attributes test counts to the unit, editor, Restricted Mode, and web suites by job', async () => {
        const { testCountsFromLog } = await load();
        const desktop = testCountsFromLog('Test (ubuntu-latest, VS Code stable)', UNIT_LOG);
        assert.equal(desktop.kind, 'desktop');
        assert.equal(desktop.unit.length, 2);
        assert.equal(desktop.editor.passing, 56);
        assert.deepEqual(desktop.restricted,
            ['real Restricted Mode blocks Git-backed viewing and permits explicit hunk-only reviews.']);
        assert.equal(desktop.web, undefined);
        const web = testCountsFromLog('Web tests (vscode.dev)', WEB_LOG);
        assert.deepEqual([web.kind, web.unit, web.editor, web.web],
            ['web', [], undefined, { passing: 5, failing: 0, pending: 0 }]);
        const crashed = testCountsFromLog('Web tests (vscode.dev)', log('test:web failed: browser closed'));
        assert.deepEqual([crashed.kind, crashed.web, crashed.restricted], ['web', undefined, []]);
    });
});

describe('quality dashboard verdicts', () => {
    const marketplace = { available: true, version: '0.3.2', preRelease: true, vsixSha256: DIGEST };
    const recorded = (overrides: Json = {}): Json => ({
        available: true,
        packaged: { channel: 'pre-release', sha256: DIGEST },
        publishing: { channel: 'pre-release', sha256: DIGEST },
        openVsx: { sha256: DIGEST },
        publishedVersion: '0.3.2',
        ...overrides,
    });

    test('matches digests from every job and the Marketplace download of the published version', async () => {
        const { digestVerdict } = await load();
        const verdict = digestVerdict(recorded(), marketplace);
        assert.equal(verdict.status, 'match');
        assert.deepEqual(verdict.digests.map((digest: Json) => digest.source), [
            'CI package job', 'Marketplace publish job', 'Open VSX publish job', 'Marketplace download of 0.3.2',
        ]);
        const older = digestVerdict(recorded(), { ...marketplace, version: '0.3.3', vsixSha256: OTHER });
        assert.equal(older.status, 'match', 'a later Marketplace version is not compared with this run');
        assert.equal(older.digests.length, 3);
    });

    test('reports a mismatch for a differing digest or channel', async () => {
        const { digestVerdict } = await load();
        const changed = digestVerdict(recorded({ publishing: { channel: 'pre-release', sha256: OTHER } }), marketplace);
        assert.equal(changed.status, 'mismatch');
        assert.match(changed.detail, /^Marketplace publish job: digest differs from the CI package job$/);
        const served = digestVerdict(recorded(), { ...marketplace, vsixSha256: OTHER });
        assert.equal(served.status, 'mismatch');
        const channel = digestVerdict(recorded({ publishing: { channel: 'regular', sha256: DIGEST } }));
        assert.equal(channel.status, 'mismatch');
        assert.match(channel.detail, /channels differ: pre-release and regular/);
    });

    test('reports not recorded or unavailable instead of claiming a match', async () => {
        const { digestVerdict } = await load();
        const old = digestVerdict({ available: true, publishedVersion: '0.3.1' }, { ...marketplace, version: '0.3.1' });
        assert.equal(old.status, 'not recorded');
        assert.match(old.detail, /only one digest to compare, from the Marketplace download of 0\.3\.1/);
        assert.equal(digestVerdict({ available: true }, marketplace).status, 'not recorded');
        assert.deepEqual(digestVerdict({ available: false, reason: 'job logs can be read only with GITHUB_TOKEN' }),
            { status: 'unavailable', detail: 'job logs can be read only with GITHUB_TOKEN', digests: [] });
    });

    test('summarizes runs on main: pass rate over decisive runs, re-runs, and durations', async () => {
        const { summarizeRuns } = await load();
        const summary = summarizeRuns([
            run({ id: 7, run_number: 7, status: 'in_progress', conclusion: null, created_at: '2026-11-11T07:00:00Z' }),
            run({ id: 6, run_number: 6, event: 'pull_request', conclusion: 'failure', created_at: '2026-11-11T06:30:00Z' }),
            run({ id: 5, run_number: 5 }),
            run({ id: 4, run_number: 4, conclusion: 'failure', created_at: '2026-11-10T06:00:00Z' }),
            run({ id: 3, run_number: 3, conclusion: 'cancelled', created_at: '2026-11-09T07:00:00Z' }),
            run({ id: 2, run_number: 2, run_attempt: 2, created_at: '2026-11-09T06:00:00Z',
                run_started_at: '2026-11-09T06:10:00Z', updated_at: '2026-11-09T06:15:00Z' }),
        ]);
        assert.deepEqual(summary.runs.map((entry: Json) => entry.number), [7, 5, 4, 3, 2]);
        assert.equal(summary.latest.number, 5);
        assert.equal(summary.pending, 1);
        assert.deepEqual([summary.passed, summary.decisive, summary.passRate], [2, 3, 2 / 3]);
        assert.deepEqual([summary.reruns, summary.passedAfterRerun], [1, 1]);
        assert.equal(summary.medianDurationMs, 240_000);
        const publish = summarizeRuns([
            run({ id: 3, event: 'push', head_branch: 'v0.3.2' }),
            run({ id: 2, event: 'workflow_dispatch', head_branch: 'main' }),
            run({ id: 1, event: 'workflow_dispatch', head_branch: 'feature' }),
        ], { publish: true });
        assert.deepEqual(publish.runs.map((entry: Json) => entry.ref), ['v0.3.2', 'main']);
    });

    test('reads the Marketplace query and treats an Open VSX 404 as not listed', async () => {
        const { parseMarketplace, parseOpenVsx } = await load();
        assert.deepEqual(parseMarketplace(MARKETPLACE), {
            version: '0.3.2',
            preRelease: true,
            vsixSha256: DIGEST,
            lastUpdated: '2026-11-12T00:00:00Z',
            installs: 3,
            downloads: 29,
            updates: 1,
            url: 'https://marketplace.visualstudio.com/items?itemName=waddahmoghram.view-patch',
        });
        assert.throws(() => parseMarketplace({ results: [{ extensions: [] }] }), /has no extension/);
        assert.equal(parseOpenVsx(404, { error: 'Extension not found: waddahmoghram.view-patch' }).listed, false);
        const listed = parseOpenVsx(200, { version: '0.3.2', preRelease: false, downloadCount: 5, verified: true });
        assert.deepEqual([listed.listed, listed.version, listed.preRelease, listed.downloads], [true, '0.3.2', false, 5]);
        assert.throws(() => parseOpenVsx(503, { error: 'unavailable' }), /Open VSX returned 503: unavailable/);
    });

    test('lists only Dependabot pull requests, aging them in whole days', async () => {
        const { dependabotPulls } = await load();
        const pulls = dependabotPulls([
            { number: 9, title: 'Bump esbuild', user: { login: 'dependabot[bot]' }, created_at: '2026-10-27T13:00:00Z' },
            { number: 8, title: 'A contributor', user: { login: 'someone' }, created_at: '2026-10-01T00:00:00Z' },
        ], new Date('2026-11-11T12:00:00Z'));
        assert.deepEqual(pulls.map(pull => [pull.number, pull.ageDays]), [[9, 14]]);
    });

    test('is ready only when every rule passes, not ready on any failure, and otherwise undetermined', async () => {
        const { readiness, RULES } = await load();
        const latest = (conclusion: string): Json => ({ number: 8, sha: '84c7a7c0', event: 'push', conclusion });
        const report = (overrides: Json = {}): Json => ({
            workflows: {
                ci: { available: true, latest: latest('success'), pending: 0 },
                codeql: { available: true, latest: latest('success'), pending: 1 },
            },
            digests: { status: 'not recorded', detail: 'no completed Publish run yet', digests: [] },
            dependabot: { available: true, pulls: [{ number: 9, ageDays: 14 }] },
            ...overrides,
        });
        const ready = readiness(report());
        assert.equal(ready.verdict, 'ready');
        assert.deepEqual(ready.rules.map((rule: Json) => [rule.id, rule.status, rule.text]),
            Object.entries(RULES).map(([id, text]) => [id, 'pass', text]));
        assert.match(ready.rules[1].detail, /run #8 on 84c7a7c \(push\) concluded success; 1 newer run/);
        const stale = readiness(report({ dependabot: { available: true, pulls: [{ number: 9, ageDays: 15 }] } }));
        assert.deepEqual([stale.verdict, stale.rules[3].status], ['not ready', 'fail']);
        assert.match(stale.rules[3].detail, /stale: #9/);
        const failing = report();
        failing.workflows.ci.latest = latest('failure');
        assert.equal(readiness(failing).verdict, 'not ready');
        const cancelled = report();
        cancelled.workflows.codeql.latest = latest('cancelled');
        assert.equal(readiness(cancelled).verdict, 'undetermined');
        const noLogs = readiness(report({ digests: { status: 'unavailable', detail: 'no token', digests: [] } }));
        assert.deepEqual([noLogs.verdict, noLogs.rules[2].status], ['undetermined', 'unknown']);
        assert.equal(readiness(report({ digests: { status: 'mismatch', detail: '', digests: [] } })).verdict,
            'not ready');
    });
});

interface Sent {
    url: string;
    init: Json;
}

const NOW = new Date('2026-11-11T12:00:00Z');
const API = 'https://api.github.com/repos/o/r';
const isGitHub = (request: Sent): boolean => request.url.startsWith('https://api.github.com/');

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Json {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

// A fetch that answers only the given addresses, recording every request; anything else gets a 404.
function fakeFetch(routes: Record<string, () => Json>, sent: Sent[]) {
    return async (url: string, init: Json = {}) => {
        sent.push({ url, init });
        const route = routes[url];
        return route ? route() : respond(404, { message: 'Not Found' });
    };
}

function job(id: number, name: string): Json {
    return {
        id,
        name,
        status: 'completed',
        conclusion: 'success',
        html_url: `https://github.com/o/r/actions/runs/1/job/${id}`,
        started_at: '2026-11-11T06:00:00Z',
        completed_at: '2026-11-11T06:01:10Z',
    };
}

function routes(pullTitle = 'Bump esbuild'): Record<string, () => Json> {
    return {
        'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery': () => respond(200, MARKETPLACE),
        'https://open-vsx.org/api/waddahmoghram/view-patch':
            () => respond(404, { error: 'Extension not found: waddahmoghram.view-patch' }),
        [`${API}/actions/workflows/ci.yml/runs?branch=main&per_page=30`]:
            () => respond(200, { workflow_runs: [run({ id: 101 })] }),
        [`${API}/actions/workflows/codeql.yml/runs?branch=main&per_page=30`]:
            () => respond(200, { workflow_runs: [run({ id: 102, run_number: 4 })] }),
        [`${API}/actions/workflows/publish.yml/runs?per_page=30`]:
            () => respond(200, { workflow_runs: [run({ id: 103, run_number: 3, event: 'workflow_dispatch' })] }),
        [`${API}/actions/runs/101/jobs?per_page=100`]: () => respond(200, {
            jobs: [job(201, 'Test (ubuntu-latest, VS Code stable)'), job(202, 'Web tests (vscode.dev)'), job(203, 'package')],
        }),
        [`${API}/actions/runs/103/jobs?per_page=100`]: () => respond(200, {
            jobs: [job(301, 'verify / Test (ubuntu-latest, VS Code stable)'), job(302, 'verify / package'),
                job(303, 'publish'), job(304, 'open-vsx')],
        }),
        [`${API}/actions/jobs/201/logs`]: () => respond(200, UNIT_LOG),
        [`${API}/actions/jobs/202/logs`]: () => respond(200, WEB_LOG),
        [`${API}/actions/jobs/302/logs`]: () => respond(200, PACKAGE_LOG),
        [`${API}/actions/jobs/303/logs`]: () => respond(200, PUBLISH_LOG),
        [`${API}/actions/jobs/304/logs`]: () => respond(200, OPEN_VSX_LOG),
        [`${API}/pulls?state=open&per_page=100`]: () => respond(200, [{
            number: 9,
            title: pullTitle,
            html_url: 'https://github.com/o/r/pull/9',
            user: { login: 'dependabot[bot]' },
            created_at: '2026-11-04T12:00:00Z',
        }]),
    };
}

describe('quality dashboard collection', () => {
    test('stays within six unauthenticated GitHub requests and leaves log-derived values unavailable', async () => {
        const { collect } = await load();
        const sent: Sent[] = [];
        const report = await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(routes(), sent) });
        const github = sent.filter(isGitHub);
        assert.equal(github.length, 6);
        assert.equal(report.githubRequests, 6);
        assert.ok(github.every(request => !request.url.endsWith('/logs') && !('Authorization' in request.init.headers)));
        assert.deepEqual([report.testCounts.available, report.digests.status], [false, 'unavailable']);
        assert.match(report.testCounts.reason, /GITHUB_TOKEN/);
        assert.deepEqual([report.marketplace.version, report.openVsx.listed, report.dependabot.pulls[0].ageDays],
            ['0.3.2', false, 7]);
        assert.deepEqual(report.readiness.rules.map((rule: Json) => rule.status), ['pass', 'pass', 'unknown', 'pass']);
        assert.equal(report.readiness.verdict, 'undetermined');
    });

    test('reads test counts and digests from job logs when a token is given, sending it only to GitHub', async () => {
        const { collect } = await load();
        const sent: Sent[] = [];
        const report = await collect({ repository: 'o/r', token: 'secret-token', now: NOW, fetch: fakeFetch(routes(), sent) });
        assert.deepEqual(report.testCounts.jobs.map((entry: Json) =>
            [entry.name, entry.unit[0]?.tests, entry.editor?.passing, entry.restricted.length, entry.web?.passing]), [
            ['Test (ubuntu-latest, VS Code stable)', 334, 56, 1, undefined],
            ['Web tests (vscode.dev)', undefined, undefined, 0, 5],
        ]);
        assert.deepEqual([report.digests.status, report.digests.digests.length], ['match', 4]);
        assert.equal(report.readiness.verdict, 'ready');
        assert.equal(sent.filter(request => request.url.endsWith('/logs')).length, 5);
        assert.ok(sent.filter(isGitHub).every(request => request.init.headers.Authorization === 'Bearer secret-token'));
        assert.ok(sent.filter(request => !isGitHub(request))
            .every(request => !JSON.stringify(request.init).includes('secret-token')));
    });

    test('turns failing sources into unavailable entries instead of throwing', async () => {
        const { collect, renderHtml, renderMarkdown } = await load();
        const sent: Sent[] = [];
        const failing: Record<string, () => Json> = {
            'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery': () => {
                throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
            },
            'https://open-vsx.org/api/waddahmoghram/view-patch': () => respond(502, { error: 'bad | gateway' }),
            [`${API}/actions/workflows/ci.yml/runs?branch=main&per_page=30`]: () => respond(403,
                { message: 'API rate limit exceeded' },
                { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-11-11T13:00:00Z') / 1000) }),
        };
        const report = await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(failing, sent) });
        assert.equal(sent.filter(isGitHub).length, 1, 'no GitHub request may follow a spent rate limit');
        assert.match(report.workflows.ci.reason, /rate limit is spent until 2026-11-11 13:00 UTC/);
        assert.match(report.dependabot.reason, /rate limit is spent/);
        assert.equal(report.marketplace.reason, 'fetch failed (ENOTFOUND)');
        assert.equal(report.openVsx.reason, 'Open VSX returned 502: bad | gateway');
        assert.ok(report.readiness.rules.every((rule: Json) => rule.status === 'unknown'));
        assert.equal(report.readiness.verdict, 'undetermined');
        assert.match(renderHtml(report), /unavailable: fetch failed \(ENOTFOUND\)/);
        assert.match(renderMarkdown(report), /\| Open VSX \| unavailable: Open VSX returned 502: bad \\\| gateway \|/);
    });
});

describe('quality dashboard output', () => {
    test('renders one self-contained page without scripts or external assets, escaping all data', async () => {
        const { collect, renderHtml } = await load();
        const hostile = routes('<script>alert(1)</script>');
        hostile[`${API}/actions/runs/101/jobs?per_page=100`] =
            () => respond(200, { jobs: [{ ...job(201, 'Test <b>'), html_url: 'javascript:alert(1)' }] });
        const html = renderHtml(await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(hostile, []) }));
        assert.doesNotMatch(html, /<script|<link|<img|<iframe|\ssrc=|@import|url\(|javascript:/i);
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /<th scope="row">Test &lt;b&gt;<\/th>/);
        assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'"/);
        assert.match(html, /@media \(prefers-color-scheme: dark\)/);
        assert.match(html, /<caption>Readiness rules<\/caption>/);
        assert.match(html, /<th scope="col">Evidence<\/th>/);
        assert.match(html, /unavailable: job logs can be read only with GITHUB_TOKEN/);
    });

    test('writes a Markdown summary with the verdict and every rule', async () => {
        const { collect, renderMarkdown, RULES } = await load();
        const markdown = renderMarkdown(await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(routes(), []) }));
        assert.match(markdown, /^## View Patch quality dashboard\n\n\*\*Release readiness: undetermined\*\*\n/);
        for (const text of Object.values(RULES)) {
            assert.ok(markdown.includes(`| ${text} | `), text);
        }
        assert.match(markdown, /\| Marketplace \| 0\.3\.2 \(pre-release\); 3 installs, 29 downloads, 1 updates \|/);
        assert.match(markdown, /\| Open VSX \| not listed \|/);
        assert.match(markdown, /\| Dependabot pull requests \| #9 \(7 days\) \|/);
    });
});
