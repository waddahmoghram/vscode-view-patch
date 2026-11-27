// Builds a quality dashboard for View Patch from GitHub Actions, release, and registry data.
//
//   node scripts/quality-dashboard.mjs [--history-dir <folder>]
//
// Environment: GITHUB_REPOSITORY (owner/name, default waddahmoghram/vscode-view-patch), GITHUB_TOKEN (optional),
// DASHBOARD_OUT (output folder, default .dashboard), DASHBOARD_HISTORY_DIR (same as --history-dir), and
// GITHUB_STEP_SUMMARY (set by GitHub Actions; a Markdown summary is appended to it). Writes <out>/index.html, a
// self-contained page without scripts, <out>/data.json, and <out>/metrics-YYYY-MM-DD.json, a compact snapshot of
// the aggregate numbers. Snapshots from earlier days found in the history folder or its subfolders give the page
// its changes since the previous snapshot; reading them makes no requests.
//
// Without a token the run makes six GitHub requests, far below the unauthenticated limit of 60 an hour, and the
// values that only job logs hold (test counts and package digests) are reported as unavailable. A source that
// fails becomes "unavailable: <reason>" instead of stopping the run.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION_ID = 'waddahmoghram.view-patch';
export const MAX_DEPENDABOT_AGE_DAYS = 14;
export const REQUEST_BUDGET = { anonymous: 20, authenticated: 60 };
const WORKFLOWS = [
    { id: 'ci', file: 'ci.yml', name: 'CI' },
    { id: 'codeql', file: 'codeql.yml', name: 'CodeQL' },
    { id: 'publish', file: 'publish.yml', name: 'Publish' },
];
// Conclusions that say whether the work passed; cancelled, skipped, and neutral runs say nothing either way.
const DECISIVE = new Set(['success', 'failure', 'timed_out', 'startup_failure']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 30_000;

// eslint-disable-next-line no-control-regex
const COLOR = /\u001b\[[\d;]*[A-Za-z]/g;
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;

/** A job log's lines without GitHub's timestamps and terminal colors. */
export function logLines(text) {
    return text.split(/\r?\n/).map(line => line.replace(COLOR, '').replace(TIMESTAMP, '').trimEnd());
}

/** Every `node --test` summary in a log, in order, as { tests, suites, pass, fail, cancelled, skipped, todo }. */
export function parseNodeTestSummaries(text) {
    const summaries = [];
    for (const line of logLines(text)) {
        const match = /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
        if (match?.[1] === 'tests') {
            summaries.push({ tests: Number(match[2]) });
        } else if (match && summaries.length > 0) {
            summaries.at(-1)[match[1]] = Number(match[2]);
        }
    }
    return summaries;
}

/** The last Mocha summary in a log, as { passing, failing, pending }, or undefined. */
export function parseMochaSummary(text) {
    let summary;
    for (const line of logLines(text)) {
        const match = /^\s*(\d+) (passing|failing|pending)\b/.exec(line);
        if (match?.[2] === 'passing') {
            summary = { passing: Number(match[1]), failing: 0, pending: 0 };
        } else if (match && summary) {
            summary[match[2]] = Number(match[1]);
        }
    }
    return summary;
}

/** The scenarios that the Restricted Mode run reported as passing. */
export function parseRestrictedPasses(text) {
    return logLines(text).flatMap(line => /^PASS: (.+)$/.exec(line)?.[1] ?? []);
}

/**
 * The digest lines that the CI package job and the Publish jobs print, and the version that vsce reports as
 * published. The workflow commands that print them are echoed into the log too, but carry no 64-digit digest.
 */
export function parseDigestLines(text) {
    const found = {};
    for (const line of logLines(text)) {
        let match;
        if ((match = /^Packaged view-patch\.vsix \((regular|pre-release)\), SHA-256 ([\da-f]{64})$/.exec(line))) {
            found.packaged = { channel: match[1], sha256: match[2] };
        } else if ((match = /^Publishing view-patch\.vsix \((regular|pre-release)\), SHA-256 ([\da-f]{64})$/.exec(line))) {
            found.publishing = { channel: match[1], sha256: match[2] };
        } else if ((match = /^Publishing view-patch\.vsix to Open VSX, SHA-256 ([\da-f]{64})$/.exec(line))) {
            found.openVsx = { sha256: match[1] };
        } else if ((match = /\bPublished [\w.-]+ v(\d+\.\d+\.\d+)\.?$/.exec(line))) {
            found.publishedVersion = match[1];
        }
    }
    return found;
}

/** Test counts from one CI job's log: the unit and editor suites in Test jobs, the web suite in the web job. */
export function testCountsFromLog(jobName, text) {
    if (/^Web tests\b/.test(jobName)) {
        return { kind: 'web', unit: [], editor: undefined, restricted: [], web: parseMochaSummary(text) };
    }
    return {
        kind: 'desktop',
        unit: parseNodeTestSummaries(text),
        editor: parseMochaSummary(text),
        restricted: parseRestrictedPasses(text),
        web: undefined,
    };
}

/**
 * The Publish run's jobs that print a package digest, each with the parseDigestLines field it prints. They are
 * matched by their exact names, so that no other job, such as a smoke test of the installed package, is read for a
 * digest; CI's package job runs in Publish as "verify / package". Only the Open VSX job may be left out, because it
 * runs only when the repository enables it.
 */
const DIGEST_JOBS = [
    { key: 'packaged', source: 'CI package job', names: ['verify / package', 'package'], required: true },
    { key: 'publishing', source: 'Marketplace publish job', names: ['publish'], required: true },
    { key: 'openVsx', source: 'Open VSX publish job', names: ['open-vsx'], required: false },
];

async function readDigestTarget({ key, required }, job, readLog) {
    if (!job) {
        return { state: 'missing', detail: 'not in this run' };
    }
    if (job.conclusion === 'skipped') {
        return { state: 'skipped', detail: required ? 'skipped' : 'skipped, not enabled for this run' };
    }
    const succeeded = job.conclusion === 'success';
    const state = succeeded ? 'unverified' : 'failed';
    const outcome = succeeded ? '' : `concluded ${job.conclusion ?? job.status}, `;
    let found;
    try {
        found = parseDigestLines(await readLog(job.id));
    } catch (error) {
        return { state, detail: `${outcome}log unavailable (${error?.message ?? error})` };
    }
    if (!found[key]) {
        return { state, detail: `${outcome}printed no digest`, found };
    }
    return { state: succeeded ? 'recorded' : 'failed', detail: `${outcome}digest recorded`, found };
}

/**
 * Reads the digest that each of a Publish run's digest jobs printed; readLog(jobId) returns a job's log. A skipped
 * job never ran, so its log is not read. Returns the parseDigestLines fields, each from the job that prints it, and
 * each job's state: recorded, skipped, missing, failed (concluded other than success), or unverified (succeeded
 * without a readable digest).
 */
export async function readDigestTargets(jobs, readLog) {
    const recorded = { targets: [] };
    for (const target of DIGEST_JOBS) {
        const job = jobs.find(entry => target.names.includes(entry.name));
        const { found, ...result } = await readDigestTarget(target, job, readLog);
        if (found?.[target.key]) {
            recorded[target.key] = found[target.key];
        }
        if (target.key === 'publishing' && found?.publishedVersion) {
            recorded.publishedVersion = found.publishedVersion;
        }
        recorded.targets.push({ key: target.key, source: target.source, required: target.required, job, ...result });
    }
    return recorded;
}

const describeTarget = target => `${target.source}: ${target.detail}`;

/**
 * Compares the digests that a Publish run recorded, plus the Marketplace's own digest when the Marketplace's latest
 * version is the one that run published. `recorded` is { available, reason } or the readDigestTargets result.
 * Status: match, mismatch, not recorded (fewer than two digests to compare), or unavailable: no job logs, or a job
 * that did not succeed with a digest, unless it is an optional job that the run skipped or lacks.
 */
export function digestVerdict(recorded, marketplace) {
    if (!recorded?.available) {
        return { status: 'unavailable', detail: recorded?.reason ?? 'no job logs', digests: [] };
    }
    const digests = DIGEST_JOBS.flatMap(({ key, source }) => (recorded[key] ? [{ source, ...recorded[key] }] : []));
    if (marketplace?.available && marketplace.vsixSha256 && recorded.publishedVersion === marketplace.version) {
        digests.push({
            source: `Marketplace download of ${marketplace.version}`,
            channel: marketplace.preRelease ? 'pre-release' : 'regular',
            sha256: marketplace.vsixSha256,
        });
    }
    const targets = recorded.targets ?? [];
    const result = (status, detail) => ({ status, detail, digests, targets });
    const differing = digests.filter(digest => digest.sha256 !== digests[0].sha256);
    if (differing.length > 0) {
        return result('mismatch',
            `${differing.map(digest => digest.source).join(', ')}: digest differs from the ${digests[0].source}`);
    }
    const channels = [...new Set(digests.flatMap(digest => digest.channel ?? []))];
    if (channels.length > 1) {
        return result('mismatch', `the digests agree but the channels differ: ${channels.join(' and ')}`);
    }
    const leftOut = target => !target.required && (target.state === 'skipped' || target.state === 'missing');
    const unverified = targets.filter(target => target.state !== 'recorded' && !leftOut(target));
    if (unverified.length > 0) {
        return result('unavailable', unverified.map(describeTarget).join('; '));
    }
    if (digests.length < 2) {
        return result('not recorded', digests.length === 0
            ? 'the run printed no package digest; runs before same-package publishing did not'
            : `only one digest to compare, from the ${digests[0].source}`);
    }
    const notes = targets.filter(leftOut).map(describeTarget);
    return result('match', [`${digests.length} digests agree`, ...notes].join('; '));
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) {
        return undefined;
    }
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Undefined unless both times are valid and in order; GitHub gives a skipped job a completion before its start.
function elapsed(start, end) {
    const ms = Date.parse(end) - Date.parse(start);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * Summarizes a workflow's runs, newest first. CI and CodeQL keep runs on main that a pull request did not start.
 * Publish keeps release-tag pushes and runs started from main, because a tag run reports the tag as its branch.
 */
export function summarizeRuns(rawRuns, { publish = false } = {}) {
    const runs = rawRuns
        .filter(run => (publish
            ? run.event === 'push' || run.head_branch === 'main'
            : run.head_branch === 'main' && !String(run.event).startsWith('pull_request')))
        .map(run => ({
            id: run.id,
            number: run.run_number,
            attempt: run.run_attempt ?? 1,
            event: run.event,
            ref: run.head_branch,
            sha: run.head_sha,
            title: run.display_title,
            status: run.status,
            conclusion: run.conclusion,
            url: run.html_url,
            createdAt: run.created_at,
            startedAt: run.run_started_at ?? run.created_at,
            durationMs: run.status === 'completed' ? elapsed(run.run_started_at ?? run.created_at, run.updated_at) : undefined,
        }))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const completed = runs.filter(run => run.status === 'completed');
    const decisive = completed.filter(run => DECISIVE.has(run.conclusion));
    const passed = decisive.filter(run => run.conclusion === 'success').length;
    const reruns = completed.filter(run => run.attempt > 1);
    return {
        runs,
        latest: completed[0],
        pending: runs.length - completed.length,
        decisive: decisive.length,
        passed,
        passRate: decisive.length > 0 ? passed / decisive.length : undefined,
        reruns: reruns.length,
        passedAfterRerun: reruns.filter(run => run.conclusion === 'success').length,
        medianDurationMs: median(completed.filter(run => run.conclusion === 'success').map(run => run.durationMs)),
    };
}

/** A run's jobs with their durations. */
export function summarizeJobs(rawJobs) {
    return rawJobs.map(job => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url,
        durationMs: elapsed(job.started_at, job.completed_at),
    }));
}

/** The Publish run whose digests matter: the latest successful one, or else the latest completed one. */
export function choosePublishRun(publish) {
    if (!publish?.available) {
        return undefined;
    }
    return publish.runs.find(run => run.conclusion === 'success') ?? publish.latest;
}

/** The latest version, channel, digest, and statistics from a Marketplace extension query (flags 785). */
export function parseMarketplace(body) {
    const extension = body?.results?.[0]?.extensions?.[0];
    if (!extension) {
        throw new Error(`the Marketplace has no extension ${EXTENSION_ID}`);
    }
    const version = extension.versions?.[0];
    const property = key => version?.properties?.find(entry => entry.key === key)?.value;
    const statistic = name => extension.statistics?.find(entry => entry.statisticName === name)?.value;
    return {
        version: version?.version,
        preRelease: property('Microsoft.VisualStudio.Code.PreRelease') === 'true',
        vsixSha256: property('Microsoft.VisualStudio.Services.VsixSha256'),
        lastUpdated: version?.lastUpdated ?? extension.lastUpdated,
        installs: statistic('install'),
        downloads: statistic('downloadCount'),
        updates: statistic('updateCount'),
        url: `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`,
    };
}

/** An Open VSX extension response; a 404 means the extension is not listed there. */
export function parseOpenVsx(status, body) {
    const url = `https://open-vsx.org/extension/${EXTENSION_ID.replace('.', '/')}`;
    if (status === 404) {
        return { listed: false, url };
    }
    if (status !== 200 || typeof body?.version !== 'string') {
        throw new Error(`Open VSX returned ${status}${body?.error ? `: ${body.error}` : ''}`);
    }
    return {
        listed: true,
        version: body.version,
        preRelease: body.preRelease === true,
        downloads: body.downloadCount,
        verified: body.verified === true,
        lastUpdated: body.timestamp,
        url,
    };
}

/** Open pull requests that Dependabot opened, with their age in whole days. */
export function dependabotPulls(pulls, now) {
    return pulls
        .filter(pull => pull.user?.login === 'dependabot[bot]')
        .map(pull => ({
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
            createdAt: pull.created_at,
            ageDays: Math.floor((now.getTime() - Date.parse(pull.created_at)) / DAY_MS),
        }));
}

export const RULES = {
    ci: 'The latest completed CI run on main succeeded',
    codeql: 'The latest completed CodeQL run on main did not fail',
    digests: 'The latest successful Publish run recorded matching package digests, or none to compare',
    dependabot: `No Dependabot pull request has been open longer than ${MAX_DEPENDABOT_AGE_DAYS} days`,
};

const describeRun = run => `run #${run.number} on ${String(run.sha).slice(0, 7)} (${run.event}) concluded ${run.conclusion}`;

function latestRunRule(id, workflow, name, judge) {
    if (!workflow?.available) {
        return { id, status: 'unknown', detail: `${name} runs unavailable: ${workflow?.reason ?? 'not collected'}` };
    }
    if (!workflow.latest) {
        return { id, status: 'unknown', detail: `no completed ${name} run on main` };
    }
    const pending = workflow.pending > 0 ? `; ${workflow.pending} newer run(s) not finished` : '';
    return { id, status: judge(workflow.latest.conclusion), detail: describeRun(workflow.latest) + pending };
}

/**
 * Release readiness: ready when every rule passes, not ready when any rule fails, and undetermined when none fails
 * but at least one cannot be evaluated, for example because job logs need a token.
 */
export function readiness(report) {
    const digestStatus = { match: 'pass', 'not recorded': 'pass', mismatch: 'fail', unavailable: 'unknown' };
    const stale = report.dependabot?.available
        ? report.dependabot.pulls.filter(pull => pull.ageDays > MAX_DEPENDABOT_AGE_DAYS)
        : [];
    const rules = [
        latestRunRule('ci', report.workflows?.ci, 'CI', conclusion => (conclusion === 'success' ? 'pass' : 'fail')),
        latestRunRule('codeql', report.workflows?.codeql, 'CodeQL', conclusion => (conclusion === 'success'
            ? 'pass'
            : FAILED.has(conclusion) ? 'fail' : 'unknown')),
        {
            id: 'digests',
            status: digestStatus[report.digests?.status] ?? 'unknown',
            detail: `${report.digests?.status ?? 'unavailable'}: ${report.digests?.detail ?? 'not collected'}`,
        },
        report.dependabot?.available
            ? {
                id: 'dependabot',
                status: stale.length > 0 ? 'fail' : 'pass',
                detail: report.dependabot.pulls.length === 0
                    ? 'none open'
                    : `${report.dependabot.pulls.length} open; oldest ${Math.max(...report.dependabot.pulls.map(pull => pull.ageDays))} days`
                        + (stale.length > 0 ? `; stale: ${stale.map(pull => `#${pull.number}`).join(', ')}` : ''),
            }
            : { id: 'dependabot', status: 'unknown', detail: `pull requests unavailable: ${report.dependabot?.reason}` },
    ].map(rule => ({ ...rule, text: RULES[rule.id] }));
    const verdict = rules.some(rule => rule.status === 'fail')
        ? 'not ready'
        : rules.some(rule => rule.status === 'unknown') ? 'undetermined' : 'ready';
    return { verdict, rules };
}

export const SNAPSHOT_KIND = 'view-patch-dashboard-metrics';
export const SNAPSHOT_FILE = /^metrics-(\d{4}-\d\d-\d\d)\.json$/;
// The workflow runs daily, so a page or snapshot older than this means it has stopped.
export const STALE_AFTER_MS = 2 * DAY_MS;

// Reads one number from a collected source, or the reason it is unknown; never a 0 for an unknown value.
function measure(source, pick, missing) {
    if (!source?.available) {
        return { reason: source?.reason ?? 'not collected' };
    }
    const value = pick(source);
    return Number.isFinite(value) ? { value } : { reason: typeof missing === 'function' ? missing(source) : missing };
}

const rounded = value => (Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : value);
const firstCount = (report, pick) => report.testCounts?.jobs?.map(pick).find(Number.isFinite);

/** The aggregate public numbers each dated snapshot keeps, in display order. */
export const METRICS = [
    ['ciPassRate', 'CI pass rate on main', 'rate',
        report => measure(report.workflows?.ci, workflow => rounded(workflow.passRate), 'no decisive CI run')],
    ['ciReruns', 'CI re-runs', 'count',
        report => measure(report.workflows?.ci, workflow => workflow.reruns, 'not collected')],
    ['ciMedianDurationMs', 'CI median successful duration', 'duration',
        report => measure(report.workflows?.ci, workflow => workflow.medianDurationMs, 'no successful CI run')],
    ['codeqlPassRate', 'CodeQL pass rate on main', 'rate',
        report => measure(report.workflows?.codeql, workflow => rounded(workflow.passRate), 'no decisive CodeQL run')],
    ['publishPassRate', 'Publish pass rate', 'rate',
        report => measure(report.workflows?.publish, workflow => rounded(workflow.passRate), 'no decisive Publish run')],
    ['unitTests', 'Unit tests in the latest CI run', 'count',
        report => measure(report.testCounts, () => firstCount(report, job => job.unit?.[0]?.tests), 'no unit summary')],
    ['editorTestsPassing', 'Editor tests passing', 'count',
        report => measure(report.testCounts, () => firstCount(report, job => job.editor?.passing), 'no editor summary')],
    ['webTestsPassing', 'Web tests passing', 'count',
        report => measure(report.testCounts, () => firstCount(report, job => job.web?.passing), 'no web summary')],
    ['marketplaceInstalls', 'Marketplace installs', 'count',
        report => measure(report.marketplace, marketplace => marketplace.installs, 'no install statistic')],
    ['marketplaceDownloads', 'Marketplace downloads', 'count',
        report => measure(report.marketplace, marketplace => marketplace.downloads, 'no download statistic')],
    ['marketplaceUpdates', 'Marketplace updates', 'count',
        report => measure(report.marketplace, marketplace => marketplace.updates, 'no update statistic')],
    ['openVsxDownloads', 'Open VSX downloads', 'count',
        report => measure(report.openVsx, openVsx => (openVsx.listed ? openVsx.downloads : undefined),
            openVsx => (openVsx.listed ? 'no download count' : 'not listed on Open VSX'))],
    ['dependabotOpen', 'Open Dependabot pull requests', 'count',
        report => measure(report.dependabot, dependabot => dependabot.pulls?.length, 'not collected')],
].map(([key, label, kind, read]) => ({ key, label, kind, read }));

/** The UTC date of a timestamp, as YYYY-MM-DD. */
export function snapshotDate(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) {
        throw new Error(`"${iso}" is not a valid time`);
    }
    return new Date(time).toISOString().slice(0, 10);
}

export const snapshotFileName = iso => `metrics-${snapshotDate(iso)}.json`;

/**
 * The compact snapshot written next to data.json: aggregate public numbers only, with null and a reason in
 * `unavailable` for each value the run could not read.
 */
export function metricsSnapshot(report) {
    const metrics = {};
    const unavailable = {};
    for (const { key, read } of METRICS) {
        const { value, reason } = read(report);
        metrics[key] = value ?? null;
        if (value === undefined) {
            unavailable[key] = reason;
        }
    }
    return {
        kind: SNAPSHOT_KIND,
        schemaVersion: 1,
        date: snapshotDate(report.generatedAt),
        generatedAt: report.generatedAt,
        repository: report.repository,
        readiness: report.readiness?.verdict ?? null,
        marketplaceVersion: report.marketplace?.available ? report.marketplace.version ?? null : null,
        metrics,
        unavailable,
    };
}

/** A snapshot file's contents, checked; throws with the reason a file cannot be used. */
export function parseSnapshot(text, fileName) {
    let snapshot;
    try {
        snapshot = JSON.parse(text);
    } catch {
        throw new Error('not valid JSON');
    }
    if (snapshot?.kind !== SNAPSHOT_KIND || snapshot.schemaVersion !== 1) {
        throw new Error(`not a version 1 ${SNAPSHOT_KIND} snapshot`);
    }
    if (!Number.isFinite(Date.parse(snapshot.generatedAt)) || snapshot.date !== snapshotDate(snapshot.generatedAt)) {
        throw new Error('its date and generation time disagree');
    }
    if (fileName && SNAPSHOT_FILE.exec(path.basename(fileName))?.[1] !== snapshot.date) {
        throw new Error(`its date ${snapshot.date} does not match its file name`);
    }
    if (typeof snapshot.metrics !== 'object' || snapshot.metrics === null) {
        throw new Error('it has no metrics');
    }
    return snapshot;
}

/**
 * Snapshots in a folder and its subfolders, where `gh run download` puts each artifact; undefined without a
 * folder. A missing folder holds no snapshots, and a file that cannot be used is listed with its reason.
 */
export function readHistory(dir) {
    if (!dir) {
        return undefined;
    }
    let names;
    try {
        names = readdirSync(dir, { recursive: true }).map(String);
    } catch (error) {
        return error?.code === 'ENOENT'
            ? { available: true, snapshots: [], skipped: [] }
            : { available: false, reason: `cannot read ${dir}: ${error?.message ?? error}` };
    }
    const snapshots = [];
    const skipped = [];
    for (const name of names.filter(entry => SNAPSHOT_FILE.test(path.basename(entry))).sort()) {
        try {
            snapshots.push(parseSnapshot(readFileSync(path.join(dir, name), 'utf8'), name));
        } catch (error) {
            skipped.push({ file: name, reason: error?.message ?? String(error) });
        }
    }
    return { available: true, snapshots, skipped };
}

const finite = value => (Number.isFinite(value) ? value : null);

/** Each metric now, in the previous snapshot, and the change; the change is null unless both values are known. */
export function metricDeltas(current, previous) {
    return METRICS.map(({ key, label, kind }) => {
        const now = finite(current.metrics?.[key]);
        const before = previous ? finite(previous.metrics?.[key]) : null;
        let previousReason;
        if (!previous) {
            previousReason = 'no previous snapshot';
        } else if (before === null) {
            previousReason = previous.unavailable?.[key]
                ?? (previous.metrics && Object.hasOwn(previous.metrics, key) ? 'not collected' : 'not in that snapshot');
        }
        return {
            key,
            label,
            kind,
            current: now,
            currentReason: now === null ? current.unavailable?.[key] ?? 'not collected' : undefined,
            previous: before,
            previousReason,
            delta: now !== null && before !== null ? rounded(now - before) : null,
        };
    });
}

/**
 * The change since the newest snapshot of this repository from an earlier UTC day. Several runs a day each write
 * that day's snapshot, so only an earlier day counts as previous.
 */
export function trend(current, history) {
    const base = !history
        ? { available: false, reason: 'no history folder was given', snapshotsRead: 0, skipped: [] }
        : !history.available
            ? { available: false, reason: history.reason, snapshotsRead: 0, skipped: [] }
            : { available: true, snapshotsRead: history.snapshots.length, skipped: history.skipped };
    const previous = (history?.snapshots ?? [])
        .filter(snapshot => snapshot.repository === current.repository && snapshot.date < current.date)
        .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0];
    return {
        ...base,
        previous: previous && {
            date: previous.date,
            generatedAt: previous.generatedAt,
            readiness: previous.readiness,
            marketplaceVersion: previous.marketplaceVersion,
        },
        rows: metricDeltas(current, previous),
    };
}

/** Milliseconds from a time to now, or undefined when the time is missing or invalid. */
export function ageOf(iso, now) {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? Math.max(0, now.getTime() - time) : undefined;
}

export function formatAge(ms) {
    if (!Number.isFinite(ms)) {
        return '—';
    }
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 1) {
        return 'under an hour';
    }
    if (hours < 48) {
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${Math.floor(ms / DAY_MS)} days`;
}

const latestTime = (workflow, name) => (!workflow?.available
    ? { reason: workflow?.reason ?? 'not collected' }
    : workflow.latest ? { at: workflow.latest.startedAt } : { reason: `no completed ${name} run` });

/**
 * How old the page and each source are at `now`, by default when the page was generated. The page itself is
 * stale once it is older than STALE_AFTER_MS.
 */
export function freshness(report, now = new Date(report.generatedAt)) {
    const sources = [
        ['This dashboard', { at: report.generatedAt }],
        ['Latest completed CI run on main', latestTime(report.workflows?.ci, 'CI')],
        ['Latest completed CodeQL run on main', latestTime(report.workflows?.codeql, 'CodeQL')],
        ['Latest completed Publish run', latestTime(report.workflows?.publish, 'Publish')],
        ['Marketplace version published', report.marketplace?.available
            ? report.marketplace.lastUpdated ? { at: report.marketplace.lastUpdated } : { reason: 'no update time' }
            : { reason: report.marketplace?.reason ?? 'not collected' }],
        ['Previous metrics snapshot', report.trend?.previous
            ? { at: report.trend.previous.generatedAt }
            : { reason: report.trend?.available === false ? report.trend.reason : 'no snapshot from an earlier day' }],
    ];
    const rows = sources.map(([label, { at, reason }]) => {
        const ageMs = ageOf(at, now);
        return { label, at, ageMs, reason: ageMs === undefined ? reason ?? 'no valid time' : undefined };
    });
    const ageMs = rows[0].ageMs;
    return { ageMs, stale: ageMs === undefined || ageMs > STALE_AFTER_MS, rows };
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char]);
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return '—';
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const formatTime = iso => (Number.isFinite(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const formatCount = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');
const safeUrl = url => (typeof url === 'string' && url.startsWith('https://') ? url : undefined);
const link = (text, url) => (safeUrl(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text));
const unavailable = reason => `<span class="unavailable">unavailable: ${escapeHtml(reason ?? 'not collected')}</span>`;

const TONES = {
    pass: 'pass', ready: 'pass', match: 'pass', success: 'pass',
    fail: 'fail', 'not ready': 'fail', mismatch: 'fail', failure: 'fail', timed_out: 'fail', startup_failure: 'fail',
    unknown: 'warn', undetermined: 'warn', unavailable: 'warn',
};
const SYMBOLS = { pass: '✓', fail: '✗', warn: '?', neutral: '–' };

function badge(label, extraClass = '') {
    const tone = Object.hasOwn(TONES, label) ? TONES[label] : 'neutral';
    return `<span class="badge ${tone}${extraClass}">${SYMBOLS[tone]} ${escapeHtml(label ?? 'pending')}</span>`;
}

function table(caption, headers, rows) {
    const head = headers.map(header => `<th scope="col">${escapeHtml(header)}</th>`).join('');
    const body = rows
        .map(([first, ...rest]) => `<tr><th scope="row">${first}</th>${rest.map(cell => `<td>${cell}</td>`).join('')}</tr>`)
        .join('\n');
    return `<div class="scroll"><table>\n<caption>${escapeHtml(caption)}</caption>\n<thead><tr>${head}</tr></thead>\n`
        + `<tbody>\n${body}\n</tbody>\n</table></div>`;
}

const runLink = run => `${link(`#${run.number}`, run.url)} ${badge(run.conclusion ?? run.status)}`;

function unitCell(summaries) {
    if (!summaries?.length) {
        return '—';
    }
    const [first] = summaries;
    const failing = summaries.some(summary => (summary.fail ?? 0) > 0 || (summary.cancelled ?? 0) > 0);
    const runs = summaries.length > 1 ? `, ${summaries.length} runs` : '';
    return `${failing ? `${badge('fail')} ` : ''}${first.tests} tests: ${first.pass ?? '?'} pass, ${first.fail ?? '?'} fail${runs}`;
}

function mochaCell(summary) {
    if (!summary) {
        return '—';
    }
    const pending = summary.pending > 0 ? `, ${summary.pending} pending` : '';
    return `${summary.failing > 0 ? `${badge('fail')} ` : ''}${summary.passing} passing, ${summary.failing} failing${pending}`;
}

function readinessSection({ readiness: { verdict, rules } }) {
    const rows = rules.map(rule => [escapeHtml(rule.text), badge(rule.status), escapeHtml(rule.detail)]);
    return `<section aria-labelledby="readiness">
<h2 id="readiness">Release readiness: ${badge(verdict, ' verdict')}</h2>
<p>Ready when every rule passes, not ready when any rule fails, and undetermined when no rule fails but at least one
cannot be evaluated.</p>
${table('Readiness rules', ['Rule', 'Result', 'Evidence'], rows)}
</section>`;
}

function workflowSection(report) {
    const rows = WORKFLOWS.map(({ id, name }) => {
        const workflow = report.workflows[id];
        if (!workflow?.available) {
            return [escapeHtml(name), unavailable(workflow?.reason), '—', '—', '—'];
        }
        const latest = workflow.latest;
        return [
            escapeHtml(name),
            latest ? `${runLink(latest)} ${escapeHtml(formatTime(latest.startedAt))}` : 'no completed run',
            workflow.passRate === undefined
                ? '—'
                : `${Math.round(workflow.passRate * 100)}% (${workflow.passed} of ${workflow.decisive})`,
            workflow.reruns === 0 ? '0' : `${workflow.reruns} (${workflow.passedAfterRerun} passed after a re-run)`,
            escapeHtml(formatDuration(workflow.medianDurationMs)),
        ];
    });
    const jobs = report.ciJobs?.available
        ? table(`Jobs of CI run #${report.ciJobs.run.number}`, ['Job', 'Result', 'Duration'],
            report.ciJobs.jobs.map(job => [link(job.name, job.url), badge(job.conclusion ?? job.status),
                escapeHtml(formatDuration(job.durationMs))]))
        : `<p>Jobs of the latest CI run: ${unavailable(report.ciJobs?.reason)}</p>`;
    const counts = report.testCounts?.available
        ? table('Test counts in the latest CI run\'s logs', ['Job', 'Unit (node:test)', 'Editor (Mocha)',
            'Restricted Mode', 'Web (Mocha)'], report.testCounts.jobs.map(job => [
            escapeHtml(job.name),
            unitCell(job.unit),
            mochaCell(job.editor),
            job.kind === 'web' ? '—' : job.restricted.length > 0 ? `${job.restricted.length} PASS` : `${badge('fail')} no PASS line`,
            mochaCell(job.web),
        ]))
        : `<p>Test counts from job logs: ${unavailable(report.testCounts?.reason)}</p>`;
    return `<section aria-labelledby="workflows">
<h2 id="workflows">Workflows on main</h2>
${table('Recent history (up to 30 runs each)', ['Workflow', 'Latest completed run', 'Pass rate', 'Re-runs',
        'Median successful duration'], rows)}
${jobs}
${counts}
</section>`;
}

function releaseSection(report) {
    const run = report.publishRun?.run;
    const publish = report.publishRun?.available
        ? run
            ? `<p>Publish run ${runLink(run)} from ${escapeHtml(run.ref)} (${escapeHtml(run.event)}),
started ${escapeHtml(formatTime(run.startedAt))}.</p>`
            : '<p>No completed Publish run yet.</p>'
        : `<p>Publish runs: ${unavailable(report.publishRun?.reason)}</p>`;
    const digests = report.digests;
    const digestTable = digests.digests.length > 0
        ? table('Recorded package digests', ['Source', 'Channel', 'SHA-256'], digests.digests.map(digest => [
            escapeHtml(digest.source), escapeHtml(digest.channel ?? '—'), `<code class="digest">${escapeHtml(digest.sha256)}</code>`]))
        : '';
    const targetTable = digests.targets?.length > 0
        ? table('Publish run jobs that record the package digest', ['Digest source', 'Job', 'Result', 'Digest',
            'Duration'], digests.targets.map(target => [
            escapeHtml(target.source),
            target.job ? link(target.job.name, target.job.url) : '—',
            target.job ? badge(target.job.conclusion ?? target.job.status) : '—',
            escapeHtml(target.detail),
            escapeHtml(formatDuration(target.job?.durationMs)),
        ]))
        : '';
    const marketplace = report.marketplace;
    const openVsx = report.openVsx;
    const registries = [
        marketplace?.available
            ? [link('Visual Studio Marketplace', marketplace.url), escapeHtml(marketplace.version),
                marketplace.preRelease ? 'pre-release' : 'regular', formatCount(marketplace.installs),
                formatCount(marketplace.downloads), formatCount(marketplace.updates), escapeHtml(formatTime(marketplace.lastUpdated))]
            : ['Visual Studio Marketplace', unavailable(marketplace?.reason), '—', '—', '—', '—', '—'],
        !openVsx?.available
            ? ['Open VSX', unavailable(openVsx?.reason), '—', '—', '—', '—', '—']
            : openVsx.listed
                ? [link('Open VSX', openVsx.url), escapeHtml(openVsx.version), openVsx.preRelease ? 'pre-release' : 'regular',
                    '—', formatCount(openVsx.downloads), '—',
                    `${escapeHtml(formatTime(openVsx.lastUpdated))}${openVsx.verified ? '' : ' (unverified namespace)'}`]
                : ['Open VSX', 'not listed', '—', '—', '—', '—', '—'],
    ];
    const local = report.packageVersion?.available
        ? `<p>This checkout's <code>package.json</code> version: ${escapeHtml(report.packageVersion.version)}.</p>`
        : '';
    return `<section aria-labelledby="release">
<h2 id="release">Release</h2>
${publish}
<p>Package digests: ${badge(digests.status)} ${escapeHtml(digests.detail)}</p>
${digestTable}
${targetTable}
${table('Registries', ['Registry', 'Latest version', 'Channel', 'Installs', 'Downloads', 'Updates', 'Last updated'],
        registries)}
${local}
</section>`;
}

function dependencySection({ dependabot }) {
    const body = !dependabot?.available
        ? `<p>${unavailable(dependabot?.reason)}</p>`
        : dependabot.pulls.length === 0
            ? '<p>No open Dependabot pull requests.</p>'
            : table('Open Dependabot pull requests', ['Pull request', 'Title', 'Opened', 'Age'],
                dependabot.pulls.map(pull => [link(`#${pull.number}`, pull.url), escapeHtml(pull.title),
                    escapeHtml(formatTime(pull.createdAt)),
                    `${pull.ageDays > MAX_DEPENDABOT_AGE_DAYS ? `${badge('fail')} ` : ''}${pull.ageDays} days`]));
    return `<section aria-labelledby="dependencies">
<h2 id="dependencies">Dependency updates</h2>
${body}
</section>`;
}

/** A metric value as text: a percentage, a duration, or a count. */
export function formatMetric(kind, value) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return kind === 'rate' ? `${Math.round(value * 100)}%` : kind === 'duration' ? formatDuration(value) : formatCount(value);
}

/** A change between two known values; zero is "no change", never a stand-in for an unknown value. */
export function formatDelta(kind, delta) {
    if (!Number.isFinite(delta)) {
        return '—';
    }
    if (delta === 0) {
        return 'no change';
    }
    const sign = delta > 0 ? '+' : '-';
    const size = Math.abs(delta);
    if (kind === 'rate') {
        return `${sign}${(size * 100).toFixed(1)} points`;
    }
    return `${sign}${kind === 'duration' ? formatDuration(size) : formatCount(size)}`;
}

function freshnessSection(report) {
    const rows = freshness(report).rows.map(row => [escapeHtml(row.label),
        row.ageMs === undefined ? unavailable(row.reason) : escapeHtml(formatTime(row.at)),
        row.ageMs === undefined ? '—' : escapeHtml(formatAge(row.ageMs))]);
    return `<section aria-labelledby="freshness">
<h2 id="freshness">Freshness</h2>
<p>This page does not update itself. A new one is built at least daily, so if it was generated more than
${STALE_AFTER_MS / DAY_MS} days before you read it, the workflow has stopped and every value below is stale.</p>
${table('Ages when this page was generated', ['Source', 'Time', 'Age'], rows)}
</section>`;
}

function trendSection({ trend: summary }) {
    if (!summary) {
        return '';
    }
    const cellOf = (row, side) => (row[side] === null
        ? unavailable(row[`${side}Reason`])
        : escapeHtml(formatMetric(row.kind, row[side])));
    const rows = summary.rows.map(row => [escapeHtml(row.label), cellOf(row, 'current'), cellOf(row, 'previous'),
        escapeHtml(formatDelta(row.kind, row.delta))]);
    const previous = summary.previous;
    const source = !summary.available
        ? `<p>Previous snapshots: ${unavailable(summary.reason)}</p>`
        : `<p>${summary.snapshotsRead} snapshot(s) read; ${previous
            ? `comparing with the one from ${escapeHtml(previous.date)}, generated `
                + `${escapeHtml(formatTime(previous.generatedAt))}.`
            : 'none is from an earlier day.'}</p>`;
    const skipped = summary.skipped.length > 0
        ? `<p>Skipped: ${summary.skipped.map(entry => `<code>${escapeHtml(entry.file)}</code> (${escapeHtml(entry.reason)})`)
            .join(', ')}.</p>`
        : '';
    return `<section aria-labelledby="trend">
<h2 id="trend">Change since the previous snapshot</h2>
${source}
${skipped}
${table('Metrics now and in the previous snapshot', ['Metric', 'Now', 'Previous', 'Change'], rows)}
</section>`;
}

function historySection(report) {
    const tables = WORKFLOWS.filter(({ id }) => report.workflows[id]?.available).map(({ id, name }) =>
        table(`${name}: latest runs`, ['Run', 'Started', 'Event', 'Commit', 'Attempts', 'Duration'],
            report.workflows[id].runs.slice(0, 10).map(run => [runLink(run), escapeHtml(formatTime(run.startedAt)),
                escapeHtml(run.event), `<code>${escapeHtml(String(run.sha).slice(0, 7))}</code>`, String(run.attempt),
                escapeHtml(formatDuration(run.durationMs))])));
    return `<section aria-labelledby="history">
<h2 id="history">Run history</h2>
${tables.join('\n') || '<p>No workflow runs could be read.</p>'}
</section>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0;
  --stripe: #f6f8fa; --link: #0969da; --pass-bg: #dafbe1; --pass-fg: #116329; --fail-bg: #ffebe9;
  --fail-fg: #a40e26; --warn-bg: #fff8c5; --warn-fg: #7d4e00; --neutral-bg: #eff2f5; --neutral-fg: #424a53; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --stripe: #151b23; --link: #4493f8;
    --pass-bg: #12301f; --pass-fg: #56d364; --fail-bg: #3c1618; --fail-fg: #ff7b72; --warn-bg: #352a0c;
    --warn-fg: #e3b341; --neutral-bg: #262c36; --neutral-fg: #c9d1d9; }
}
body { margin: 0 auto; max-width: 75rem; padding: 1.5rem; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); }
h1 { margin-bottom: 0.25rem; }
h2 { margin-top: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1.25rem; }
caption { text-align: left; font-weight: 600; padding: 0.25rem 0; }
th, td { border: 1px solid var(--border); padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
thead th { background: var(--stripe); }
tbody tr:nth-child(even) { background: var(--stripe); }
tbody th { font-weight: 600; }
.badge { display: inline-block; padding: 0 0.5rem; border-radius: 1rem; font-weight: 600; white-space: nowrap; }
.verdict { font-size: 1.1em; }
.pass { background: var(--pass-bg); color: var(--pass-fg); }
.fail { background: var(--fail-bg); color: var(--fail-fg); }
.warn { background: var(--warn-bg); color: var(--warn-fg); }
.neutral { background: var(--neutral-bg); color: var(--neutral-fg); }
.muted, .unavailable { color: var(--muted); }
.unavailable { font-style: italic; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
.digest { word-break: break-all; }
`;

/** The dashboard as one self-contained page: inline styles, no scripts, and no external assets. */
export function renderHtml(report) {
    const repository = escapeHtml(report.repository);
    const access = report.authenticated
        ? 'Read with a token.'
        : 'Read without a token, so values that only job logs hold are unavailable.';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="light dark">
<title>View Patch quality dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>View Patch quality dashboard</h1>
<p class="muted">Generated ${escapeHtml(formatTime(report.generatedAt))} for
${link(report.repository, `https://github.com/${report.repository}`)}. ${access}
${report.githubRequests} GitHub API requests.</p>
</header>
<main>
${readinessSection(report)}
${freshnessSection(report)}
${workflowSection(report)}
${releaseSection(report)}
${dependencySection(report)}
${trendSection(report)}
${historySection(report)}
<section aria-labelledby="method">
<h2 id="method">How this page is computed</h2>
<ul>
<li>Runs on main exclude runs started by pull requests. Publish runs include release-tag pushes and runs started
from main. The pass rate counts successes among runs that succeeded, failed, or timed out; cancelled and skipped
runs are left out. A re-run is a run whose latest attempt is not its first, a sign of flaky tests or
infrastructure.</li>
<li>Package digests come from the latest successful Publish run, or the latest completed one when none succeeded.
The CI package job, each publishing job, and the Marketplace's download of the version that run published must
all agree. The Open VSX job runs only when it is enabled; a run that skipped it shows it as skipped and leaves it
out. Every other job, and an Open VSX job that ran, must succeed and print its digest, or the result is
unavailable unless the digests already disagree. A duration that a job's or run's times cannot give, such as a
skipped job's, is unavailable: it is shown as — and left out of medians.</li>
<li>Test counts are the runners' own summaries in the latest CI run's job logs on ${repository}.</li>
<li>Registry figures are as the Visual Studio Marketplace and Open VSX report them.</li>
<li>Each build also writes <code>metrics-YYYY-MM-DD.json</code>, a snapshot of the aggregate numbers above, named
for its UTC day. Changes compare with the newest snapshot from an earlier day; a value that either snapshot could
not read is shown as unavailable and has no change, never 0.</li>
</ul>
</section>
</main>
</body>
</html>
`;
}

const cell = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function workflowText(workflow) {
    if (!workflow?.available) {
        return `unavailable: ${workflow?.reason}`;
    }
    const latest = workflow.latest ? `latest #${workflow.latest.number} ${workflow.latest.conclusion}` : 'no completed run';
    const rate = workflow.passRate === undefined ? '' : `; ${workflow.passed} of ${workflow.decisive} passed`;
    return `${latest}${rate}; ${workflow.reruns} re-run(s)`;
}

function countsText(job) {
    if (job.kind === 'web') {
        return job.web ? `web ${job.web.passing} passing, ${job.web.failing} failing` : 'web —';
    }
    const unit = job.unit[0] ? `unit ${job.unit[0].pass}/${job.unit[0].tests} pass` : 'unit —';
    const editor = job.editor ? `editor ${job.editor.passing} passing, ${job.editor.failing} failing` : 'editor —';
    return `${unit}, ${editor}, Restricted Mode ${job.restricted.length > 0 ? 'PASS' : 'no PASS line'}`;
}

/** A Markdown summary for the GitHub Actions run page. */
export function renderMarkdown(report) {
    const { marketplace, openVsx, dependabot } = report;
    const tests = report.testCounts?.available
        ? report.testCounts.jobs.map(job => `${job.name}: ${countsText(job)}`).join('; ')
        : `unavailable: ${report.testCounts?.reason}`;
    const registry = marketplace?.available
        ? `${marketplace.version} (${marketplace.preRelease ? 'pre-release' : 'regular'}); `
            + `${formatCount(marketplace.installs)} installs, ${formatCount(marketplace.downloads)} downloads, `
            + `${formatCount(marketplace.updates)} updates`
        : `unavailable: ${marketplace?.reason}`;
    const openVsxText = !openVsx?.available
        ? `unavailable: ${openVsx?.reason}`
        : openVsx.listed ? `${openVsx.version} (${openVsx.preRelease ? 'pre-release' : 'regular'})` : 'not listed';
    const pulls = !dependabot?.available
        ? `unavailable: ${dependabot?.reason}`
        : dependabot.pulls.map(pull => `#${pull.number} (${pull.ageDays} days)`).join(', ') || 'none open';
    return [
        '## View Patch quality dashboard',
        '',
        `**Release readiness: ${report.readiness.verdict}**`,
        '',
        '| Rule | Result | Evidence |',
        '| --- | --- | --- |',
        ...report.readiness.rules.map(rule => `| ${cell(rule.text)} | ${cell(rule.status)} | ${cell(rule.detail)} |`),
        '',
        '| Signal | Value |',
        '| --- | --- |',
        ...WORKFLOWS.map(({ id, name }) => `| ${name} | ${cell(workflowText(report.workflows[id]))} |`),
        `| Package digests | ${cell(`${report.digests.status}: ${report.digests.detail}`)} |`,
        `| Digest jobs | ${cell(report.digests.targets?.map(describeTarget).join('; ') || undefined)} |`,
        `| Test counts | ${cell(tests)} |`,
        `| Marketplace | ${cell(registry)} |`,
        `| Open VSX | ${cell(openVsxText)} |`,
        `| Dependabot pull requests | ${cell(pulls)} |`,
        '',
        ...trendMarkdown(report.trend),
    ].join('\n');
}

function trendMarkdown(summary) {
    if (!summary) {
        return [];
    }
    const value = (row, side) => (row[side] === null
        ? `unavailable: ${row[`${side}Reason`]}`
        : formatMetric(row.kind, row[side]));
    const since = summary.previous
        ? `Change since the snapshot of ${summary.previous.date}`
        : `No snapshot from an earlier day (${summary.available ? `${summary.snapshotsRead} read` : summary.reason})`;
    return [
        `**${since}**`,
        '',
        '| Metric | Now | Previous | Change |',
        '| --- | --- | --- | --- |',
        ...summary.rows.map(row => `| ${cell(row.label)} | ${cell(value(row, 'current'))} | `
            + `${cell(value(row, 'previous'))} | ${cell(formatDelta(row.kind, row.delta))} |`),
        '',
    ];
}

function gitHubClient({ apiUrl, token, fetchImpl, budget }) {
    let used = 0;
    let blocked;
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'view-patch-quality-dashboard',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    async function request(route) {
        if (blocked) {
            throw new Error(blocked);
        }
        if (used >= budget) {
            throw new Error(`the budget of ${budget} GitHub requests is spent`);
        }
        used++;
        const response = await fetchImpl(`${apiUrl}${route}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok && response.headers.get('x-ratelimit-remaining') === '0') {
            const reset = Number(response.headers.get('x-ratelimit-reset'));
            blocked = Number.isFinite(reset) && reset > 0
                ? `GitHub's rate limit is spent until ${formatTime(new Date(reset * 1000).toISOString())}`
                : 'GitHub\'s rate limit is spent';
            throw new Error(blocked);
        }
        if (!response.ok) {
            throw new Error(`GitHub returned ${response.status} for ${route.split('?')[0]}`);
        }
        return response;
    }
    return {
        get used() {
            return used;
        },
        json: async route => (await request(route)).json(),
        text: async route => (await request(route)).text(),
    };
}

// Runs one source; a failure becomes { available: false, reason } instead of an exception.
async function attempt(task) {
    try {
        return { available: true, ...(await task()) };
    } catch (error) {
        const cause = error?.cause?.code ?? error?.cause?.message;
        return { available: false, reason: `${error?.message ?? error}${cause ? ` (${cause})` : ''}` };
    }
}

async function registryJson(fetchImpl, url, init = {}) {
    const response = await fetchImpl(url, {
        ...init,
        headers: { 'User-Agent': 'view-patch-quality-dashboard', ...init.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** Collects every source into one report; GitHub requests stay within REQUEST_BUDGET. */
export async function collect({
    repository, token, now = new Date(), fetch: fetchImpl = globalThis.fetch, apiUrl = 'https://api.github.com',
    history,
}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw new Error(`GITHUB_REPOSITORY must look like owner/name, not "${repository}"`);
    }
    const github = gitHubClient({
        apiUrl, token, fetchImpl, budget: token ? REQUEST_BUDGET.authenticated : REQUEST_BUDGET.anonymous,
    });
    const base = `/repos/${repository}`;
    const needsToken = 'job logs can be read only with GITHUB_TOKEN';
    const registries = Promise.all([
        attempt(async () => {
            const { status, body } = await registryJson(fetchImpl,
                'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
                    method: 'POST',
                    headers: { Accept: 'application/json;api-version=7.2-preview.1', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 785 }),
                });
            if (status !== 200) {
                throw new Error(`the Marketplace returned ${status}`);
            }
            return parseMarketplace(body);
        }),
        attempt(async () => {
            const { status, body } = await registryJson(fetchImpl,
                `https://open-vsx.org/api/${EXTENSION_ID.replace('.', '/')}`, { headers: { Accept: 'application/json' } });
            return parseOpenVsx(status, body);
        }),
    ]);

    const workflows = {};
    for (const { id, file } of WORKFLOWS) {
        workflows[id] = await attempt(async () => {
            const query = id === 'publish' ? 'per_page=30' : 'branch=main&per_page=30';
            const body = await github.json(`${base}/actions/workflows/${file}/runs?${query}`);
            return summarizeRuns(body.workflow_runs ?? [], { publish: id === 'publish' });
        });
    }
    const jobsOf = async run => summarizeJobs((await github.json(`${base}/actions/runs/${run.id}/jobs?per_page=100`)).jobs ?? []);
    const ciJobs = await attempt(async () => {
        if (!workflows.ci.available || !workflows.ci.latest) {
            throw new Error(workflows.ci.available ? 'no completed CI run on main' : 'CI runs unavailable');
        }
        return { run: workflows.ci.latest, jobs: await jobsOf(workflows.ci.latest) };
    });
    const testCounts = await attempt(async () => {
        if (!token || !ciJobs.available) {
            throw new Error(token ? ciJobs.reason : needsToken);
        }
        const jobs = [];
        for (const job of ciJobs.jobs.filter(entry => /^(?:Test \(|Web tests\b)/.test(entry.name))) {
            const log = await github.text(`${base}/actions/jobs/${job.id}/logs`);
            jobs.push({ name: job.name, url: job.url, ...testCountsFromLog(job.name, log) });
        }
        return { jobs };
    });
    const publishRun = await attempt(async () => {
        if (!workflows.publish.available) {
            throw new Error(workflows.publish.reason);
        }
        const run = choosePublishRun(workflows.publish);
        return run ? { run, jobs: await jobsOf(run) } : { run: undefined, jobs: [] };
    });
    const recorded = await attempt(async () => {
        if (!token || !publishRun.available) {
            throw new Error(token ? publishRun.reason : needsToken);
        }
        return readDigestTargets(publishRun.jobs, id => github.text(`${base}/actions/jobs/${id}/logs`));
    });
    const dependabot = await attempt(async () => ({
        pulls: dependabotPulls(await github.json(`${base}/pulls?state=open&per_page=100`), now),
    }));
    const [marketplace, openVsx] = await registries;
    const packageVersion = await attempt(async () => ({
        version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    }));
    const digests = publishRun.available && !publishRun.run
        ? { status: 'not recorded', detail: 'no completed Publish run yet', digests: [] }
        : digestVerdict(recorded, marketplace);
    const report = {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        repository,
        authenticated: Boolean(token),
        githubRequests: github.used,
        packageVersion,
        workflows,
        ciJobs,
        testCounts,
        publishRun,
        digests,
        marketplace,
        openVsx,
        dependabot,
    };
    const complete = { ...report, readiness: readiness(report) };
    return { ...complete, trend: trend(metricsSnapshot(complete), history) };
}

async function main() {
    const { values } = parseArgs({ options: { 'history-dir': { type: 'string' } } });
    const token = process.env.GITHUB_TOKEN || undefined;
    const out = path.resolve(process.env.DASHBOARD_OUT || '.dashboard');
    const report = await collect({
        repository: process.env.GITHUB_REPOSITORY || 'waddahmoghram/vscode-view-patch',
        token,
        apiUrl: process.env.GITHUB_API_URL || undefined,
        history: readHistory(values['history-dir'] || process.env.DASHBOARD_HISTORY_DIR || undefined),
    });
    const snapshotName = snapshotFileName(report.generatedAt);
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'index.html'), renderHtml(report));
    writeFileSync(path.join(out, 'data.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(out, snapshotName), `${JSON.stringify(metricsSnapshot(report))}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
    }
    console.log(`Release readiness: ${report.readiness.verdict}`);
    for (const rule of report.readiness.rules) {
        console.log(`  ${rule.status.padEnd(7)} ${rule.text}: ${rule.detail}`);
    }
    console.log(`${report.githubRequests} GitHub requests${token ? '' : ' without a token'}; wrote `
        + `${path.join(out, 'index.html')}, data.json, and ${snapshotName}.`);
    console.log(report.trend.previous
        ? `Compared with the metrics snapshot of ${report.trend.previous.date}.`
        : `No metrics snapshot from an earlier day: ${report.trend.reason ?? `${report.trend.snapshotsRead} read`}.`);
}

// Node.js loads the entry point by its real path, so compare real paths: through a symbolic link,
// path.resolve(process.argv[1]) would not match, and the script would exit 0 without doing anything.
function isMain() {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMain()) {
    main().catch(error => {
        console.error(`quality-dashboard: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
