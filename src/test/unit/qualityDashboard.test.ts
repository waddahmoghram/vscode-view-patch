import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
    summarizeJobs(jobs: Json[]): Json[];
    parseMarketplace(body: Json): Json;
    parseOpenVsx(status: number, body: Json): Json;
    dependabotPulls(pulls: Json[], now: Date): Json[];
    readiness(report: Json): Json;
    renderHtml(report: Json): string;
    renderMarkdown(report: Json): string;
    collect(options: Json): Promise<Json>;
    snapshotFileName(iso: string): string;
    metricsSnapshot(report: Json): Json;
    readHistory(dir?: string): Json;
    metricDeltas(current: Json, previous?: Json): Json[];
    trend(current: Json, history?: Json): Json;
    formatDelta(kind: string, delta: number | null): string;
    freshness(report: Json, now?: Date): Json;
    formatAge(ms?: number): string;
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

    test('reports a reversed, invalid, or missing duration as unavailable and leaves it out of the median', async () => {
        const { summarizeJobs, summarizeRuns } = await load();
        const durations = summarizeJobs([
            // GitHub's times for the skipped open-vsx job of Publish run 43115767355.
            { ...job(1, 'open-vsx'), conclusion: 'skipped', started_at: '2026-11-11T23:00:47Z',
                completed_at: '2026-11-11T23:00:46Z' },
            { ...job(2, 'publish'), completed_at: 'not a time' },
            { ...job(3, 'verify / package'), completed_at: null },
            job(4, 'verify / package'),
        ]).map((entry: Json) => entry.durationMs);
        assert.deepEqual(durations, [undefined, undefined, undefined, 70_000]);
        const summary = summarizeRuns([
            run({ id: 2, run_number: 2, updated_at: '2026-11-11T05:59:00Z' }),
            run({ id: 1, run_number: 1, created_at: '2026-11-10T06:00:00Z', run_started_at: '2026-11-10T06:00:00Z',
                updated_at: '2026-11-10T06:04:00Z' }),
        ]);
        assert.deepEqual(summary.runs.map((entry: Json) => entry.durationMs), [undefined, 240_000]);
        assert.equal(summary.medianDurationMs, 240_000);
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

const publishJobs = (...jobs: Json[]): () => Json => () => respond(200, { jobs });
const logsRead = (sent: Sent[]): string[] =>
    sent.filter(request => request.url.endsWith('/logs')).map(request => request.url.slice(API.length));

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

    test('reads no log for a publishing job that the run skipped and compares the other digests', async () => {
        const { collect, renderHtml, renderMarkdown } = await load();
        const sent: Sent[] = [];
        const skipped = routes();
        // As in Publish run 43115767355, where OPEN_VSX_PUBLISHING was unset: the skipped job has no log.
        skipped[`${API}/actions/runs/103/jobs?per_page=100`] = publishJobs(job(302, 'verify / package'),
            job(303, 'publish'), { ...job(304, 'open-vsx'), conclusion: 'skipped', started_at: '2026-11-11T06:01:11Z',
                completed_at: '2026-11-11T06:01:10Z' });
        delete skipped[`${API}/actions/jobs/304/logs`];
        const report = await collect({ repository: 'o/r', token: 'secret-token', now: NOW, fetch: fakeFetch(skipped, sent) });
        assert.ok(!logsRead(sent).includes('/actions/jobs/304/logs'));
        assert.equal(report.digests.status, 'match');
        assert.equal(report.digests.detail, '3 digests agree; Open VSX publish job: skipped, not enabled for this run');
        assert.deepEqual(report.digests.digests.map((digest: Json) => digest.source),
            ['CI package job', 'Marketplace publish job', 'Marketplace download of 0.3.2']);
        assert.equal(report.readiness.verdict, 'ready');
        assert.match(renderHtml(report), new RegExp('<th scope="row">Open VSX publish job</th><td><a [^>]+>open-vsx</a></td>'
            + '<td><span class="badge neutral">– skipped</span></td><td>skipped, not enabled for this run</td><td>—</td>'));
        assert.match(renderMarkdown(report),
            /\| Digest jobs \| CI package job: digest recorded; .*; Open VSX publish job: skipped, not enabled for this run \|/);
    });

    test('leaves digests unavailable when the package or Marketplace publish job has no readable digest', async () => {
        const { collect } = await load();
        const noLog = routes();
        delete noLog[`${API}/actions/jobs/303/logs`];
        const missing = await collect({ repository: 'o/r', token: 'secret-token', now: NOW, fetch: fakeFetch(noLog, []) });
        assert.equal(missing.digests.status, 'unavailable');
        assert.equal(missing.digests.detail,
            'Marketplace publish job: log unavailable (GitHub returned 404 for /repos/o/r/actions/jobs/303/logs)');
        const unprinted = routes();
        unprinted[`${API}/actions/jobs/302/logs`] = () => respond(200, log('Packaged: view-patch.vsix (23 files, 130.25 KB)'));
        const silent = await collect({ repository: 'o/r', token: 'secret-token', now: NOW, fetch: fakeFetch(unprinted, []) });
        assert.equal(silent.digests.status, 'unavailable');
        assert.equal(silent.digests.detail, 'CI package job: printed no digest');
        for (const report of [missing, silent]) {
            assert.deepEqual([report.readiness.rules[2].status, report.readiness.verdict], ['unknown', 'undetermined']);
        }
    });

    test('keeps an Open VSX job that ran without a matching digest visible as failed or unverified', async () => {
        const { collect, renderHtml } = await load();
        const collectWith = (openVsx: Json, openVsxLog: string): Promise<Json> => {
            const attempted = routes();
            attempted[`${API}/actions/runs/103/jobs?per_page=100`] =
                publishJobs(job(302, 'verify / package'), job(303, 'publish'), openVsx);
            attempted[`${API}/actions/jobs/304/logs`] = () => respond(200, openVsxLog);
            return collect({ repository: 'o/r', token: 'secret-token', now: NOW, fetch: fakeFetch(attempted, []) });
        };
        const failed = await collectWith({ ...job(304, 'open-vsx'), conclusion: 'failure' }, log('npm error code E401'));
        assert.deepEqual([failed.digests.status, failed.digests.detail],
            ['unavailable', 'Open VSX publish job: concluded failure, printed no digest']);
        assert.equal(failed.readiness.verdict, 'undetermined');
        assert.match(renderHtml(failed),
            /<td><span class="badge fail">✗ failure<\/span><\/td><td>concluded failure, printed no digest<\/td>/);
        const unprinted = await collectWith(job(304, 'open-vsx'), log('Published waddahmoghram.view-patch v0.3.2.'));
        assert.deepEqual([unprinted.digests.status, unprinted.digests.detail],
            ['unavailable', 'Open VSX publish job: printed no digest']);
        const differing = await collectWith({ ...job(304, 'open-vsx'), conclusion: 'failure' },
            log(`Publishing view-patch.vsix to Open VSX, SHA-256 ${OTHER}`));
        assert.deepEqual([differing.digests.status, differing.digests.detail],
            ['mismatch', 'Open VSX publish job: digest differs from the CI package job']);
    });

    test('reads digests only from the package, publish, and Open VSX jobs, not other jobs named like them', async () => {
        const { collect } = await load();
        const sent: Sent[] = [];
        const lookalikes = routes();
        lookalikes[`${API}/actions/runs/103/jobs?per_page=100`] = publishJobs(job(302, 'verify / package'),
            job(305, 'verify / Installed VSIX smoke test'), job(306, 'verify / package smoke test'),
            job(307, 'smoke / package'), job(303, 'publish'), job(304, 'open-vsx'));
        for (const id of [305, 306, 307]) {
            lookalikes[`${API}/actions/jobs/${id}/logs`] =
                () => respond(200, log(`Packaged view-patch.vsix (pre-release), SHA-256 ${OTHER}`));
        }
        const report = await collect({ repository: 'o/r', token: 'secret-token', now: NOW, fetch: fakeFetch(lookalikes, sent) });
        assert.deepEqual(logsRead(sent), ['/actions/jobs/201/logs', '/actions/jobs/202/logs', '/actions/jobs/302/logs',
            '/actions/jobs/303/logs', '/actions/jobs/304/logs']);
        assert.deepEqual([report.digests.status, report.digests.detail], ['match', '4 digests agree']);
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

describe('quality dashboard history', () => {
    const snapshot = (date: string, metrics: Json, extra: Json = {}): Json => ({
        kind: 'view-patch-dashboard-metrics', schemaVersion: 1, date, generatedAt: `${date}T05:41:00.000Z`,
        repository: 'o/r', readiness: 'ready', marketplaceVersion: '0.3.1', metrics, unavailable: {}, ...extra,
    });

    test('writes a compact snapshot of aggregate numbers named for its UTC day, with a reason for each unknown', async () => {
        const { collect, metricsSnapshot, snapshotFileName } = await load();
        assert.equal(snapshotFileName('2026-11-11T23:59:59Z'), 'metrics-2026-11-11.json');
        assert.equal(snapshotFileName('2026-11-12T01:00:00+02:00'), 'metrics-2026-11-11.json');
        assert.throws(() => snapshotFileName('yesterday'), /not a valid time/);

        const anonymous = metricsSnapshot(await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(routes(), []) }));
        assert.deepEqual([anonymous.kind, anonymous.schemaVersion, anonymous.date, anonymous.generatedAt],
            ['view-patch-dashboard-metrics', 1, '2026-11-11', NOW.toISOString()]);
        assert.deepEqual([anonymous.metrics.ciPassRate, anonymous.metrics.marketplaceInstalls,
            anonymous.metrics.dependabotOpen, anonymous.marketplaceVersion], [1, 3, 1, '0.3.2']);
        for (const key of ['unitTests', 'editorTestsPassing', 'webTestsPassing', 'openVsxDownloads']) {
            assert.equal(anonymous.metrics[key], null, key);
        }
        assert.match(anonymous.unavailable.unitTests, /GITHUB_TOKEN/);
        assert.equal(anonymous.unavailable.openVsxDownloads, 'not listed on Open VSX');
        assert.ok(!('marketplaceInstalls' in anonymous.unavailable));
        const text = JSON.stringify(anonymous);
        assert.doesNotMatch(text, /https?:|dependabot\[bot\]|Bump esbuild|84c7a7c|\n/);

        const sent: Sent[] = [];
        const withLogs = metricsSnapshot(
            await collect({ repository: 'o/r', token: 't', now: NOW, fetch: fakeFetch(routes(), sent) }));
        assert.deepEqual([withLogs.metrics.unitTests, withLogs.metrics.editorTestsPassing, withLogs.metrics.webTestsPassing],
            [334, 56, 5]);
    });

    test('compares with the newest snapshot from an earlier day and never turns an unknown value into a change', async () => {
        const { metricDeltas, trend, formatDelta } = await load();
        const current = snapshot('2026-11-11', { marketplaceInstalls: 3, unitTests: 334, ciPassRate: 0.9, dependabotOpen: 1,
            openVsxDownloads: null }, { unavailable: { openVsxDownloads: 'not listed on Open VSX' } });
        const byKey = (rows: Json[]): Json => Object.fromEntries(rows.map(row => [row.key, row]));

        const alone = byKey(metricDeltas(current));
        assert.deepEqual([alone.marketplaceInstalls.current, alone.marketplaceInstalls.previous,
            alone.marketplaceInstalls.previousReason, alone.marketplaceInstalls.delta], [3, null, 'no previous snapshot', null]);
        assert.deepEqual([alone.openVsxDownloads.current, alone.openVsxDownloads.currentReason],
            [null, 'not listed on Open VSX']);

        const history = {
            available: true,
            skipped: [],
            snapshots: [
                snapshot('2026-11-09', { marketplaceInstalls: 0 }),
                snapshot('2026-11-10', { marketplaceInstalls: 1, unitTests: null, ciPassRate: 0.85, dependabotOpen: 1 },
                    { unavailable: { unitTests: 'job logs can be read only with GITHUB_TOKEN' } }),
                snapshot('2026-11-11', { marketplaceInstalls: 2 }),
                snapshot('2026-11-10', { marketplaceInstalls: 9 }, { repository: 'other/repo' }),
            ],
        };
        const summary = trend(current, history);
        assert.deepEqual([summary.available, summary.snapshotsRead, summary.previous.date], [true, 4, '2026-11-10']);
        const rows = byKey(summary.rows);
        assert.deepEqual([rows.marketplaceInstalls.previous, rows.marketplaceInstalls.delta], [1, 2]);
        assert.deepEqual([rows.unitTests.current, rows.unitTests.previous, rows.unitTests.delta, rows.unitTests.previousReason],
            [334, null, null, 'job logs can be read only with GITHUB_TOKEN']);
        assert.equal(rows.ciPassRate.delta, 0.05);
        assert.equal(rows.dependabotOpen.delta, 0);
        assert.equal(rows.webTestsPassing.previousReason, 'not in that snapshot');

        assert.deepEqual([formatDelta('count', rows.marketplaceInstalls.delta), formatDelta('rate', rows.ciPassRate.delta),
            formatDelta('count', 0), formatDelta('duration', -65_000), formatDelta('count', null)],
        ['+2', '+5.0 points', 'no change', '-1m 5s', '—']);
        assert.deepEqual([trend(current).available, trend(current).reason], [false, 'no history folder was given']);
        assert.equal(trend(current, { available: true, snapshots: [history.snapshots[2]], skipped: [] }).previous, undefined);
    });

    test('reads snapshots from a history folder and its subfolders, skipping unusable files', async () => {
        const { collect, readHistory, renderHtml, renderMarkdown } = await load();
        const dir = fs.mkdtempSync(path.join(__dirname, 'history-'));
        try {
            const write = (name: string, body: string): void => {
                fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
                fs.writeFileSync(path.join(dir, name), body);
            };
            write('run-7/metrics-2026-11-10.json', JSON.stringify(snapshot('2026-11-10', { marketplaceInstalls: 1 })));
            write('metrics-2026-11-09.json', JSON.stringify(snapshot('2026-11-08', { marketplaceInstalls: 0 })));
            write('metrics-2026-11-07.json', '{');
            write('notes.json', JSON.stringify(snapshot('2026-11-01', {})));
            assert.equal(readHistory(undefined), undefined);
            assert.deepEqual(readHistory(path.join(dir, 'missing')), { available: true, snapshots: [], skipped: [] });

            const history = readHistory(dir);
            assert.deepEqual(history.snapshots.map((entry: Json) => entry.date), ['2026-11-10']);
            assert.deepEqual(history.skipped, [
                { file: 'metrics-2026-11-07.json', reason: 'not valid JSON' },
                { file: 'metrics-2026-11-09.json', reason: 'its date 2026-11-08 does not match its file name' },
            ]);

            const report = await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(routes(), []), history });
            assert.equal(report.trend.previous.date, '2026-11-10');
            const html = renderHtml(report);
            assert.match(html, /<h2 id="trend">Change since the previous snapshot<\/h2>/);
            assert.match(html, /<th scope="row">Marketplace installs<\/th><td>3<\/td><td>1<\/td><td>\+2<\/td>/);
            assert.match(html,
                /<th scope="row">Unit tests in the latest CI run<\/th><td><span class="unavailable">unavailable: job logs/);
            assert.match(html, /<code>metrics-2026-11-07\.json<\/code> \(not valid JSON\)/);
            const markdown = renderMarkdown(report);
            assert.match(markdown, /\*\*Change since the snapshot of 2026-11-10\*\*/);
            assert.match(markdown, /\| Marketplace installs \| 3 \| 1 \| \+2 \|/);
            assert.match(markdown,
                /\| Open VSX downloads \| unavailable: not listed on Open VSX \| unavailable: not in that snapshot \| — \|/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('reports the age of the page and each source, and an unavailable time instead of a zero age', async () => {
        const { collect, freshness, formatAge, renderHtml } = await load();
        const report = await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch(routes(), []) });
        const atGeneration = freshness(report);
        assert.deepEqual([atGeneration.ageMs, atGeneration.stale], [0, false]);
        const rows = Object.fromEntries(atGeneration.rows.map((row: Json) => [row.label, row]));
        assert.equal(rows['Latest completed CI run on main'].ageMs, 6 * 3_600_000);
        assert.deepEqual([rows['Previous metrics snapshot'].ageMs, rows['Previous metrics snapshot'].reason],
            [undefined, 'no history folder was given']);

        const later = freshness(report, new Date(NOW.getTime() + 3 * 86_400_000));
        assert.deepEqual([later.stale, formatAge(later.ageMs)], [true, '3 days']);
        assert.deepEqual([formatAge(0), formatAge(3_600_000), formatAge(47 * 3_600_000), formatAge(undefined)],
            ['under an hour', '1 hour', '47 hours', '—']);
        assert.equal(freshness({ ...report, generatedAt: 'not a time' }).stale, true);

        const failed = await collect({ repository: 'o/r', now: NOW, fetch: fakeFetch({}, []) });
        const failedRows = freshness(failed).rows.slice(1, 5);
        assert.ok(failedRows.every((row: Json) => row.ageMs === undefined && /returned 404/.test(row.reason)),
            JSON.stringify(failedRows));
        const html = renderHtml(failed);
        assert.match(html,
            /<th scope="row">Latest completed CI run on main<\/th><td><span class="unavailable">unavailable: GitHub returned 404/);
        assert.match(html,
            /<th scope="row">Marketplace installs<\/th><td><span class="unavailable">unavailable: the Marketplace returned 404/);
        assert.doesNotMatch(html, /<th scope="row">Marketplace installs<\/th><td>0</);
    });
});
