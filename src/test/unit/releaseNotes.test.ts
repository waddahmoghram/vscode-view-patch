import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface ReleaseNotes {
    changelogSection(changelog: string, version: string): string;
    absoluteLinks(markdown: string, tag: string): string;
}

const script = path.join(__dirname, '..', '..', '..', 'scripts', 'release-notes.mjs');
const load = (): Promise<ReleaseNotes> => import(pathToFileURL(script).href);
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const BLOB = 'https://github.com/waddahmoghram/vscode-view-patch/blob';
const DIGEST = '661153806417c5cfc8fe5000a0cc5ee0b5e1a646ae18dd43bf3def316693a3c6';

const CHANGELOG = [
    '# Changelog',
    '',
    '## 1.1.0',
    '',
    '- Newest.',
    '',
    '## 1.0.0',
    '',
    '- First.',
    '',
    '### Details',
    '',
    '```text',
    '## not a heading',
    '```',
    '',
    '## 0.9.0',
    '',
    '- Oldest.',
    '',
].join('\n');

describe('release notes', () => {
    test('returns only the named section, up to the next ## heading outside code', async () => {
        const { changelogSection } = await load();
        assert.equal(changelogSection(CHANGELOG, '1.1.0'), '- Newest.');
        assert.equal(changelogSection(CHANGELOG, '1.0.0'),
            '- First.\n\n### Details\n\n```text\n## not a heading\n```');
        assert.equal(changelogSection(CHANGELOG, '0.9.0'), '- Oldest.');
    });

    test('rejects a missing or empty section, naming the version', async () => {
        const { changelogSection } = await load();
        assert.throws(() => changelogSection(CHANGELOG, '2.0.0'), /CHANGELOG\.md has no "## 2\.0\.0" section\./);
        assert.throws(() => changelogSection(CHANGELOG, '1.0'), /no "## 1\.0" section/);
        assert.throws(() => changelogSection('## 1.2.0\n\n  \n## 1.1.0\n\n- Newest.\n', '1.2.0'),
            /"## 1\.2\.0" section is empty\./);
    });

    test('points relative links at the tag and keeps absolute links, pure anchors, and code', async () => {
        const { absoluteLinks } = await load();
        const markdown = [
            'The [runbook](RELEASE_RUNBOOK.md), [its checks](./RELEASE_RUNBOOK.md#9-exit-verification), and '
                + '![the icon](images/icon.png).',
            '[Help](/README.md#troubleshooting), [Marketplace](https://marketplace.visualstudio.com/), '
                + '[mail](mailto:someone@example.com), and [below](#details).',
            '`[a code span](kept.md)` stays.',
            '```md',
            '[a fenced link](kept.md)',
            '```',
            '[plan]: TEST_PLAN.md#traceability',
        ].join('\n');
        assert.equal(absoluteLinks(markdown, 'v1.0.0'), [
            `The [runbook](${BLOB}/v1.0.0/RELEASE_RUNBOOK.md), `
                + `[its checks](${BLOB}/v1.0.0/RELEASE_RUNBOOK.md#9-exit-verification), and `
                + `![the icon](${BLOB}/v1.0.0/images/icon.png).`,
            `[Help](${BLOB}/v1.0.0/README.md#troubleshooting), [Marketplace](https://marketplace.visualstudio.com/), `
                + '[mail](mailto:someone@example.com), and [below](#details).',
            '`[a code span](kept.md)` stays.',
            '```md',
            '[a fenced link](kept.md)',
            '```',
            `[plan]: ${BLOB}/v1.0.0/TEST_PLAN.md#traceability`,
        ].join('\n'));
    });

    test('prints the real 0.3.5 section with its runbook link at the tag, then the footer', () => {
        const result = run('--version', '0.3.5', '--sha256', DIGEST.toUpperCase());
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^- The first regular release since 0\.3\.0\./);
        assert.ok(result.stdout.includes(`the [release runbook](${BLOB}/v0.3.5/RELEASE_RUNBOOK.md).\n`));
        assert.ok(!result.stdout.includes('## 0.3.4'));
        assert.ok(result.stdout.endsWith('\n\n---\n\nInstall View Patch from the [Visual Studio Marketplace]'
            + '(https://marketplace.visualstudio.com/items?itemName=waddahmoghram.view-patch).\n\n'
            + 'SHA-256 (Secure Hash Algorithm, 256-bit) digest of the attached `view-patch.vsix`: '
            + `\`${DIGEST}\`\n`));
    });

    test('exits non-zero without printing notes for a missing section or a malformed digest', () => {
        const missing = run('--version', '9.9.9');
        assert.equal(missing.status, 1);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /^release-notes: CHANGELOG\.md has no "## 9\.9\.9" section\./);
        const malformed = run('--version', '0.3.5', '--sha256', '');
        assert.equal(malformed.status, 1);
        assert.equal(malformed.stdout, '');
        assert.match(malformed.stderr, /--sha256 must be 64 hexadecimal digits/);
    });
});
