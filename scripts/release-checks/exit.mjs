// Automates the regular release runbook's exit verification (RELEASE_RUNBOOK.md section 9) for one Publish run,
// and checks a pre-release run the same way:
//
//   node scripts/release-checks/exit.mjs [--run <run>] [--wait-minutes <n>] [--out <dir>]
//   node scripts/release-checks/exit.mjs --version <x.y.z> --channel regular|pre-release [--tag] [--out <dir>]
//
// --run names a Publish run by its ID, the number after /runs/ in its address, by that address, or by the hash of
// the commit it built. Without --run or --version, the run is the newest successful Publish run that published, from
// a tag push or from main. --version without --run checks that version without a Publish run.
//
// The run must be a successful Publish run. Its CI package and publish jobs print the package's SHA-256 digest in
// their logs, which only a GitHub token with `actions: read` can read: the release-checks workflow passes its own
// GITHUB_TOKEN. Without one those steps do not run and the verdict is incomplete. The Marketplace listing, its
// download, and for a tag the GitHub release are public. Every digest found must be equal, and the channel must
// match everywhere. --wait-minutes polls the Marketplace until it lists the version (default 0: ask once).
//
// Environment: GITHUB_REPOSITORY (default waddahmoghram/vscode-view-patch), GITHUB_TOKEN, GITHUB_API_URL, and the
// GitHub Actions files GITHUB_STEP_SUMMARY and GITHUB_OUTPUT (version, channel, sha256, and tag are written there).
// Writes report.json and report.md to --out (default .release-checks/exit). Exit codes as in report.mjs; an input
// that cannot be read exits 2 before any request, with an error annotation when GitHub Actions runs it.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readZip } from '@vscode/vsce/out/zip.js';
import { readDigestTargets, summarizeJobs, summarizeRuns } from '../quality-dashboard.mjs';
import { CheckReport, EXIT, annotation, errorText } from './report.mjs';

const PUBLISHER = 'waddahmoghram';
const NAME = 'view-patch';
const ASSET = 'view-patch.vsix';
const PUBLISH_WORKFLOW = '.github/workflows/publish.yml';
const PRE_RELEASE = 'Microsoft.VisualStudio.Code.PreRelease';
const VSIX_SHA256 = 'Microsoft.VisualStudio.Services.VsixSha256';
// IncludeVersions, IncludeFiles, IncludeVersionProperties, and IncludeAssetUri: every version with its properties.
const QUERY_FLAGS = 0x1 | 0x2 | 0x10 | 0x80;
const GALLERY = 'https://marketplace.visualstudio.com/_apis/public/gallery';
const MARKETPLACE_QUERY = `${GALLERY}/extensionquery`;
const TIMEOUT_MS = 60_000;
const VERSION = /^\d+\.\d+\.\d+$/;
const CHANNELS = ['regular', 'pre-release'];

export const vspackageUrl = version => `${GALLERY}/publishers/${PUBLISHER}/vsextensions/${NAME}/${version}/vspackage`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const short = digest => `${digest.slice(0, 8)}…${digest.slice(-6)}`;
const RUN_ADDRESS = /\/actions\/runs\/(\d+)(?:[/?#]|$)/;

/**
 * Reads what --run names, ignoring surrounding spaces: a run's ID, or its address, which holds the ID after /runs/,
 * as { runId }; or the hash of the commit that a Publish run built, at least 7 characters, as { commit }. A short
 * hash can be all digits, so a number of 7 to 40 digits is both, and the run lookup falls back to the commit.
 */
export function parseRunSelector(text) {
    const value = String(text).trim();
    const runId = /^\d+$/.test(value) ? value : RUN_ADDRESS.exec(value)?.[1];
    const commit = /^[\da-f]{7,40}$/i.test(value) ? value.toLowerCase() : undefined;
    if (!runId && !commit) {
        throw new Error(`--run takes a Publish run's ID, the number after /runs/ in its address, the address itself,`
            + ` or the hash of the commit it built, not "${value}"`);
    }
    return { ...(runId ? { runId } : {}), ...(commit ? { commit } : {}) };
}

/** A version given as 1.2.3 or v1.2.3, ignoring surrounding spaces. */
export function parseVersion(text) {
    const value = String(text).trim();
    const version = value.replace(/^v/i, '');
    if (!VERSION.test(version)) {
        throw new Error(`--version must look like 1.2.3, not "${value}"`);
    }
    return version;
}

/**
 * The newest successful Publish run that published, from a tag push or from main, among a workflow's runs as the
 * GitHub API lists them; with `commit`, the newest that built a commit whose hash starts with it.
 */
export function findPublishRun(rawRuns, commit) {
    const ids = summarizeRuns(rawRuns, { publish: true }).runs
        .filter(run => run.conclusion === 'success' && (!commit || String(run.sha).toLowerCase().startsWith(commit)))
        .map(run => run.id);
    return rawRuns.find(run => run.id === ids[0]);
}

/** The tag that a Publish run was started by, such as `v0.3.9`, or undefined for a run started by hand. */
export function tagOf(run) {
    return run?.event === 'push' && /^v\d+\.\d+\.\d+$/.test(run.head_branch ?? '') ? run.head_branch : undefined;
}

/** A version's entry in a Marketplace extension query, or undefined when it is not listed. */
export function findListedVersion(body, version) {
    const extension = body?.results?.[0]?.extensions?.[0];
    const versions = extension?.versions ?? [];
    const entry = versions.find(candidate => candidate.version === version && !candidate.targetPlatform);
    if (!entry) {
        return undefined;
    }
    const property = key => entry.properties?.find(item => item.key === key)?.value;
    const regular = versions.filter(candidate =>
        candidate.properties?.find(item => item.key === PRE_RELEASE)?.value !== 'true');
    return {
        version,
        preRelease: property(PRE_RELEASE) === 'true',
        vsixSha256: property(VSIX_SHA256)?.toLowerCase(),
        validated: entry.flags === undefined || String(entry.flags).includes('validated'),
        lastUpdated: entry.lastUpdated,
        newest: versions[0]?.version,
        newestRegular: regular[0]?.version,
    };
}

/** The version and pre-release property that an extension.vsixmanifest declares. */
export function manifestFacts(xml) {
    return {
        version: /<Identity\b[^>]*\bVersion="([^"]+)"/.exec(xml)?.[1],
        preRelease: new RegExp(`Id="${PRE_RELEASE.replace(/\./g, '\\.')}" Value="true"`).test(xml),
        preReleaseProperties: (xml.match(/Code\.PreRelease/g) ?? []).length,
    };
}

/**
 * Settles the version and channel from every source that names them; a disagreement is an error. `sources` maps a
 * description to { version?, channel? }.
 */
export function settle(sources) {
    const result = {};
    for (const field of ['version', 'channel']) {
        const named = Object.entries(sources).filter(([, value]) => value?.[field] !== undefined);
        const values = [...new Set(named.map(([, value]) => value[field]))];
        if (values.length > 1) {
            throw new Error(`the ${field} differs: ${named.map(([source, value]) => `${source} says ${value[field]}`)
                .join(', ')}`);
        }
        result[field] = values[0];
        result[`${field}Sources`] = named.map(([source]) => source);
    }
    return result;
}

/** Compares every recorded digest with the first, which is the one the publish job uploaded when it is known. */
export function compareDigests(digests) {
    if (digests.length < 2) {
        throw new Error(digests.length === 0 ? 'no digest was recorded' : `only the ${digests[0].source} recorded one`);
    }
    const reference = digests[0];
    const differing = digests.filter(digest => digest.sha256 !== reference.sha256);
    if (differing.length > 0) {
        const verb = differing.length === 1 ? 'differs' : 'differ';
        throw new Error(`${differing.map(digest => `${digest.source} (${short(digest.sha256)})`).join(', ')} ${verb} `
            + `from the ${reference.source} (${short(reference.sha256)})`);
    }
    return `${digests.length} digests agree: ${reference.sha256}`;
}

async function readVsixManifest(bytes) {
    const scratch = mkdtempSync(path.join(tmpdir(), 'view-patch-exit-'));
    try {
        const file = path.join(scratch, 'package.vsix');
        writeFileSync(file, bytes);
        const manifest = (await readZip(file, name => name === 'extension.vsixmanifest')).get('extension.vsixmanifest');
        if (!manifest) {
            throw new Error('the package has no extension.vsixmanifest');
        }
        return manifest.toString('utf8');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

function client({ fetchImpl, sleep }) {
    return async function request(url, init = {}, attempts = 3) {
        for (let attempt = 1; ; attempt++) {
            let response;
            try {
                response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
            } catch (error) {
                if (attempt >= attempts) {
                    throw new Error(`${new URL(url).host}: ${errorText(error)}`);
                }
                await sleep(5_000 * attempt);
                continue;
            }
            if (response.ok) {
                return response;
            }
            if (response.status >= 500 && attempt < attempts) {
                await sleep(5_000 * attempt);
                continue;
            }
            const error = new Error(`${new URL(url).host} returned ${response.status} for ${new URL(url).pathname}`);
            throw Object.assign(error, { status: response.status });
        }
    };
}

/**
 * Runs every step and returns the report and what it settled. The Publish run is `runId`, else the newest successful
 * one that built `commit`, else, with `latest`, the newest successful one; a `runId` that names no run falls back to
 * `commit` when both are given. `fetch`, `readManifest(bytes)`, `sleep(ms)`, and `now()` can be replaced for tests.
 */
export async function verifyRelease({
    repository = 'waddahmoghram/vscode-view-patch', token, runId, commit, latest = false, version, channel,
    tag: tagFlag = false, waitMinutes = 0, apiUrl = 'https://api.github.com', fetch: fetchImpl = globalThis.fetch,
    readManifest = readVsixManifest, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(), pollMs = 60_000,
}) {
    const request = client({ fetchImpl, sleep });
    const githubHeaders = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'view-patch-release-checks',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const github = async route => (await request(`${apiUrl}${route}`, { headers: githubHeaders })).json();
    const githubText = async route => (await request(`${apiUrl}${route}`, { headers: githubHeaders })).text();
    const download = async url => Buffer.from(await (await request(url, {
        headers: { 'User-Agent': 'view-patch-release-checks' },
    })).arrayBuffer());

    const wanted = Boolean(runId || commit || latest);
    const report = new CheckReport({
        check: 'exit',
        title: 'Exit verification',
        target: {
            'View Patch': 'unknown',
            'Publish run': runId ? String(runId)
                : commit ? `the newest successful one that built ${commit}`
                    : latest ? 'the newest successful one' : 'none given',
            Repository: repository,
        },
    });
    const digests = [];
    let run;
    let picked;
    let jobs;
    let recorded;

    const findRun = async () => {
        if (runId) {
            try {
                return await github(`/repos/${repository}/actions/runs/${runId}`);
            } catch (error) {
                if (!commit || error.status !== 404) {
                    throw error;
                }
            }
        }
        const listed = await github(`/repos/${repository}/actions/workflows/${path.posix.basename(PUBLISH_WORKFLOW)}`
            + '/runs?status=success&per_page=100');
        const found = findPublishRun(listed.workflow_runs ?? [], commit);
        if (!found) {
            const checked = listed.workflow_runs?.length ?? 0;
            throw new Error(`no successful Publish run from a tag push or main ${commit ? `built commit ${commit}`
                : 'was found'} (${checked} successful Publish run${checked === 1 ? '' : 's'} checked)`);
        }
        picked = `the newest successful Publish run${commit ? ` that built ${commit}` : ''}`;
        return found;
    };

    if (wanted) {
        await report.run('1', 'Publish run', async () => {
            run = await findRun();
            const id = run.id ?? runId;
            if (run.path !== PUBLISH_WORKFLOW) {
                throw new Error(`run ${id} belongs to ${run.path ?? run.name}, not ${PUBLISH_WORKFLOW}`);
            }
            const started = tagOf(run) ? `tag ${tagOf(run)}` : `${run.event} on ${run.head_branch}`;
            report.target['Publish run'] = `${id}, attempt ${run.run_attempt ?? 1}, ${started} at `
                + `${run.head_sha?.slice(0, 7)}`;
            if (run.status !== 'completed' || run.conclusion !== 'success') {
                throw new Error(`run ${id} is ${run.status}${run.conclusion ? `, ${run.conclusion}` : ''}`);
            }
            const listed = await github(`/repos/${repository}/actions/runs/${id}/jobs?per_page=100`);
            jobs = summarizeJobs(listed.jobs ?? []);
            const outcome = name => jobs.find(job => job.name === name)?.conclusion ?? 'missing';
            for (const name of ['verify / package', 'publish']) {
                if (outcome(name) !== 'success') {
                    throw new Error(`job "${name}" is ${outcome(name)}`);
                }
            }
            if (!['success', 'skipped', 'missing'].includes(outcome('open-vsx'))) {
                throw new Error(`job "open-vsx" is ${outcome('open-vsx')}`);
            }
            return `${picked ? `picked as ${picked}; ` : ''}${jobs.length} jobs; "verify / package" and "publish" `
                + `succeeded, "open-vsx" ${outcome('open-vsx')}`;
        });
    }

    if (!wanted) {
        report.notRun('2', 'Job digests', 'no Publish run was given (--run)');
    } else if (!jobs) {
        report.notRun('2', 'Job digests', 'the Publish run could not be checked');
    } else if (!token) {
        report.notRun('2', 'Job digests', 'job logs need a GitHub token with actions: read (GITHUB_TOKEN)');
    } else {
        await report.run('2', 'Job digests', async () => {
            recorded = await readDigestTargets(jobs, id => githubText(`/repos/${repository}/actions/jobs/${id}/logs`));
            const missing = recorded.targets.filter(target => target.required && target.state !== 'recorded');
            if (missing.length > 0) {
                throw new Error(missing.map(target => `${target.source}: ${target.detail}`).join('; '));
            }
            const sources = [['publishing', 'Marketplace publish job'], ['packaged', 'CI package job'],
                ['openVsx', 'Open VSX publish job']];
            for (const [key, source] of sources) {
                if (recorded[key]) {
                    digests.push({ source, ...recorded[key] });
                }
            }
            if (recorded.packaged.channel !== recorded.publishing.channel) {
                throw new Error(`the package job packaged ${recorded.packaged.channel}, `
                    + `the publish job published ${recorded.publishing.channel}`);
            }
            const listed = digests.map(digest =>
                `${digest.source} ${short(digest.sha256)}${digest.channel ? ` (${digest.channel})` : ''}`);
            const published = recorded.publishedVersion ? `; vsce published v${recorded.publishedVersion}` : '';
            return listed.join(', ') + published;
        });
    }

    const tag = wanted ? tagOf(run) : (tagFlag && version ? `v${version}` : undefined);
    const laterSteps = [['3', 'GitHub release'], ['4', 'Marketplace listing'], ['5', 'Marketplace download'],
        ['6', 'Digest agreement']];
    // Without the run or --version, nothing can name the version; step 1's failure says why.
    if (wanted && !run && !version) {
        for (const [id, name] of [['2a', 'Version and channel'], ...laterSteps]) {
            report.notRun(id, name, 'the Publish run could not be read, so the version is unknown');
        }
        return { report, settled: undefined };
    }
    let settled;
    const resolved = await report.run('2a', 'Version and channel', async () => {
        const published = recorded?.publishedVersion;
        settled = settle({
            '--version and --channel': { version, channel },
            ...(tag ? { [`tag ${tag}`]: { version: tag.slice(1), channel: 'regular' } } : {}),
            ...(published ? { 'vsce in the publish job': { version: published } } : {}),
            ...(recorded?.publishing ? { 'the job digests': { channel: recorded.publishing.channel } } : {}),
        });
        if (!settled.version || !settled.channel) {
            throw new Error(`cannot tell the ${settled.version ? 'channel' : 'version'}; pass --version and --channel`);
        }
        report.target['View Patch'] = `${settled.version} (${settled.channel})`;
        return `${settled.version}, ${settled.channel}, from ${[...new Set([...settled.versionSources,
            ...settled.channelSources])].join(', ')}`;
    });
    if (!resolved) {
        for (const [id, name] of laterSteps) {
            report.notRun(id, name, 'the version and channel are not settled');
        }
        return { report, settled: undefined };
    }

    if (tag) {
        await report.run('3', 'GitHub release', async () => {
            const release = await github(`/repos/${repository}/releases/tags/${tag}`);
            if (release.draft) {
                throw new Error(`release ${tag} is a draft`);
            }
            if (release.prerelease) {
                throw new Error(`release ${tag} is marked as a pre-release`);
            }
            const asset = release.assets?.find(entry => entry.name === ASSET);
            if (!asset) {
                throw new Error(`release ${tag} has no ${ASSET}`);
            }
            const apiDigest = /^sha256:([\da-f]{64})$/.exec(asset.digest ?? '')?.[1];
            if (!apiDigest) {
                throw new Error(`GitHub lists no SHA-256 digest for ${ASSET}`);
            }
            const downloaded = sha256(await download(asset.browser_download_url));
            const named = [...new Set(String(release.body ?? '').match(/\b[\da-f]{64}\b/g) ?? [])];
            if (named.length !== 1) {
                const count = named.length === 0 ? 'no digest' : `${named.length} different digests`;
                throw new Error(`the release notes name ${count}`);
            }
            digests.push({ source: 'GitHub release asset (listed digest)', sha256: apiDigest },
                { source: 'GitHub release asset download', sha256: downloaded },
                { source: 'GitHub release notes', sha256: named[0] });
            return `regular, published ${release.published_at}; ${ASSET} ${asset.size} bytes; `
                + 'its listed digest, a download, and the notes recorded';
        });
    } else if (wanted && !run) {
        report.notRun('3', 'GitHub release', 'the Publish run could not be read, so its tag is unknown');
    } else {
        report.note('No GitHub release step: only a tag push creates a release.');
    }

    await report.run('4', 'Marketplace listing', async () => {
        const deadline = now() + waitMinutes * 60_000;
        let listed;
        for (;;) {
            const body = await (await request(MARKETPLACE_QUERY, {
                method: 'POST',
                headers: {
                    Accept: 'application/json;api-version=7.2-preview.1',
                    'Content-Type': 'application/json',
                    'User-Agent': 'view-patch-release-checks',
                },
                body: JSON.stringify({
                    filters: [{ criteria: [{ filterType: 7, value: `${PUBLISHER}.${NAME}` }] }],
                    flags: QUERY_FLAGS,
                }),
            })).json();
            listed = findListedVersion(body, settled.version);
            if ((listed?.validated) || now() >= deadline) {
                break;
            }
            await sleep(pollMs);
        }
        const waited = waitMinutes > 0 ? ` after ${waitMinutes} minutes` : '';
        if (!listed) {
            throw new Error(`the Marketplace does not list ${settled.version}${waited}`);
        }
        if (!listed.validated) {
            throw new Error(`the Marketplace lists ${settled.version} but has not validated it${waited}`);
        }
        if (listed.preRelease !== (settled.channel === 'pre-release')) {
            throw new Error(`listed as ${listed.preRelease ? 'a pre-release' : 'a regular version'}, `
                + `expected ${settled.channel}`);
        }
        if (listed.vsixSha256) {
            digests.push({ source: 'Marketplace listing (VsixSha256)', sha256: listed.vsixSha256 });
        }
        return `listed as ${listed.preRelease ? 'a pre-release' : 'a regular version'}, last updated `
            + `${listed.lastUpdated}; newest version ${listed.newest}, newest regular ${listed.newestRegular}`;
    });

    await report.run('5', 'Marketplace download', async () => {
        const bytes = await download(vspackageUrl(settled.version));
        if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
            throw new Error(`the download (${bytes.length} bytes) is not a ZIP file`);
        }
        const facts = manifestFacts(await readManifest(bytes));
        if (facts.version !== settled.version) {
            throw new Error(`its manifest says Version="${facts.version}"`);
        }
        if (facts.preRelease !== (settled.channel === 'pre-release')) {
            throw new Error(`its manifest ${facts.preRelease ? 'marks' : 'does not mark'} it as a pre-release`);
        }
        digests.push({ source: 'Marketplace download', sha256: sha256(bytes) });
        return `${bytes.length} bytes; manifest Version="${facts.version}"; `
            + `pre-release property count ${facts.preReleaseProperties}`;
    });

    let agreed;
    await report.run('6', 'Digest agreement', async () => {
        const detail = compareDigests(digests);
        agreed = digests[0].sha256;
        return detail;
    });
    if (digests.length > 0) {
        report.attach('Digests', digests.map(digest => `${digest.sha256}  ${digest.source}`).join('\n'));
    }
    return { report, settled: { ...settled, tag, sha256: agreed } };
}

/** Prints why the verification stopped before writing a report, as an annotation too when GitHub Actions runs it. */
function stopped(title, error, code) {
    console.error(`exit.mjs: ${errorText(error)}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(annotation('error', title, errorText(error)));
    }
    return code;
}

async function main() {
    let values;
    let selector = {};
    let version;
    try {
        ({ values } = parseArgs({
            options: {
                run: { type: 'string' },
                version: { type: 'string' },
                channel: { type: 'string' },
                tag: { type: 'boolean', default: false },
                'wait-minutes': { type: 'string', default: '0' },
                out: { type: 'string', default: path.join('.release-checks', 'exit') },
            },
        }));
        if (values.run?.trim()) {
            selector = parseRunSelector(values.run);
        }
        if (values.version?.trim()) {
            version = parseVersion(values.version);
        }
        if (values.channel !== undefined && !CHANNELS.includes(values.channel)) {
            throw new Error(`--channel must be regular or pre-release, not "${values.channel}"`);
        }
        if (!(Number(values['wait-minutes']) >= 0)) {
            throw new Error(`--wait-minutes must be a number of minutes, not "${values['wait-minutes']}"`);
        }
    } catch (error) {
        return stopped('Exit verification could not start', error, EXIT.usage);
    }
    const { report, settled } = await verifyRelease({
        repository: process.env.GITHUB_REPOSITORY || undefined,
        token: process.env.GITHUB_TOKEN || undefined,
        apiUrl: process.env.GITHUB_API_URL || undefined,
        runId: selector.runId,
        commit: selector.commit,
        latest: !selector.runId && !selector.commit && !version,
        version,
        channel: values.channel,
        tag: values.tag,
        waitMinutes: Number(values['wait-minutes']),
    });
    const code = report.write(path.resolve(values.out));
    if (process.env.GITHUB_OUTPUT && settled) {
        appendFileSync(process.env.GITHUB_OUTPUT, [`version=${settled.version}`, `channel=${settled.channel}`,
            `sha256=${settled.sha256 ?? ''}`, `tag=${settled.tag ?? ''}`, ''].join('\n'));
    }
    return code;
}

function isMain() {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMain()) {
    process.exitCode = await main().catch(error => stopped('Exit verification stopped', error, EXIT.fail));
}
