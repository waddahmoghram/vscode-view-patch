// Prints the GitHub release notes for a version: its CHANGELOG.md section, then a footer.
//
//   node scripts/release-notes.mjs [--version <x.y.z>] [--tag <tag>] [--sha256 <digest>]
//
// The version defaults to the tag without its leading v, or else to package.json's, and the tag to v<version>. A
// release body has no base address, so relative links are rewritten to the files at that tag on GitHub. The footer
// links the Marketplace listing and, given --sha256, names the package digest. A missing or empty section is an
// error, so publishing can stop on it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REPOSITORY_URL = 'https://github.com/waddahmoghram/vscode-view-patch';
export const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=waddahmoghram.view-patch';

const FENCE = /^\s*(`{3,}|~{3,})/;
// A code span, kept as is; the target of an inline link or image; or the target of a link reference definition.
const LINK = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)|(\]\(\s*)([^\s)]+)|^( {0,3}\[[^\]]+\]:\s*)(\S+)/g;

/** For each line, whether it belongs to a fenced code block, its fences included. */
function fencedLines(lines) {
    let fence;
    return lines.map(line => {
        const marker = FENCE.exec(line)?.[1];
        if (fence) {
            if (marker?.[0] === fence[0] && marker.length >= fence.length) {
                fence = undefined;
            }
            return true;
        }
        fence = marker;
        return Boolean(marker);
    });
}

/** The body of the `## <version>` section, up to the next `## ` heading, without surrounding blank lines. */
export function changelogSection(changelog, version) {
    const lines = changelog.split(/\r?\n/);
    const fenced = fencedLines(lines);
    const heading = new RegExp(`^## +${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    const start = lines.findIndex((line, index) => !fenced[index] && heading.test(line));
    if (start < 0) {
        throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
    }
    const next = lines.findIndex((line, index) => index > start && !fenced[index] && /^## /.test(line));
    const body = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n');
    if (!body.trim()) {
        throw new Error(`CHANGELOG.md's "## ${version}" section is empty.`);
    }
    return body.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

function repositoryUrl(target, tag) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) {
        return target;
    }
    const split = target.search(/[?#]/);
    const file = split < 0 ? target : target.slice(0, split);
    const suffix = split < 0 ? '' : target.slice(split);
    return `${REPOSITORY_URL}/blob/${tag}/${path.posix.normalize(file).replace(/^\/+/, '')}${suffix}`;
}

/** Markdown whose relative link targets point at the files at `tag` on GitHub; code is left alone. */
export function absoluteLinks(markdown, tag) {
    const lines = markdown.split('\n');
    const fenced = fencedLines(lines);
    return lines.map((line, index) => fenced[index] ? line : line.replace(LINK,
        (match, ticks, open, target, definition, definitionTarget) => {
            if (ticks) {
                return match;
            }
            return open ? open + repositoryUrl(target, tag) : definition + repositoryUrl(definitionTarget, tag);
        })).join('\n');
}

/** The release notes: the version's changelog section with absolute links, then the footer. */
export function releaseNotes({ changelog, version, tag = `v${version}`, sha256 }) {
    const lines = [
        absoluteLinks(changelogSection(changelog, version), tag),
        '',
        '---',
        '',
        `Install View Patch from the [Visual Studio Marketplace](${MARKETPLACE_URL}).`,
    ];
    if (sha256 !== undefined) {
        if (!/^[\da-f]{64}$/i.test(sha256)) {
            throw new Error(`--sha256 must be 64 hexadecimal digits, not "${sha256}".`);
        }
        lines.push('', `SHA-256 (Secure Hash Algorithm, 256-bit) digest of the attached \`view-patch.vsix\`: `
            + `\`${sha256.toLowerCase()}\``);
    }
    return `${lines.join('\n')}\n`;
}

function main() {
    const { values } = parseArgs({
        options: { version: { type: 'string' }, tag: { type: 'string' }, sha256: { type: 'string' } },
    });
    // A tag names its own version, so a tag without a changelog section fails instead of borrowing package.json's.
    const version = values.version
        ?? values.tag?.replace(/^v/, '')
        ?? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    process.stdout.write(releaseNotes({ changelog, version, tag: values.tag, sha256: values.sha256 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
