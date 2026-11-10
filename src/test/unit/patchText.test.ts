import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
    DEFAULT_MAX_PATCH_BYTES,
    OperationCancelledError,
    OperationLimitError,
    OperationOptions,
} from '../../operations';
import { HunkFile, parseHunks, PatchParseError, splitPatchMessages } from '../../patchText';

const FIRST = '1234567890abcdef1234567890abcdef12345678';
const SECOND = 'abcdef1234567890abcdef1234567890abcdef12';
const DATE = 'Mon, 9 Nov 2026 12:00:00 +0000';
const SIGNATURE = '-- \n2.45.0\n';

function mail(subject: string, body: string, commit = FIRST): string {
    return [
        `From ${commit} Mon Sep 17 00:00:00 2001`,
        'From: Sample Author <author@example.test>',
        `Date: ${DATE}`,
        `Subject: ${subject}`,
        '',
        body,
    ].join('\n');
}

function subjectOnlyMail(subject: string, body: string): string {
    return `From ${'0'.repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: ${subject}\n\n${body}`;
}

function diff(
    hunks = '@@ -1 +1 @@\n-old\n+new\n',
    path = 'sample.txt',
    metadata = 'index 1111111..2222222 100644\n',
): string {
    return `diff --git a/${path} b/${path}\n${metadata}--- a/${path}\n+++ b/${path}\n${hunks}`;
}

function onlyFile(text: string | Buffer, options?: OperationOptions): HunkFile {
    const parts = parseHunks(typeof text === 'string' ? Buffer.from(text) : text, options);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].files.length, 1);
    return parts[0].files[0];
}

function binaryBlock(content: Buffer): string {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
    const compressed = deflateSync(content);
    const rows: string[] = [];
    for (let offset = 0; offset < compressed.length; offset += 52) {
        const chunk = compressed.subarray(offset, offset + 52);
        let row = String.fromCharCode(chunk.length <= 26 ? chunk.length + 64 : chunk.length + 70);
        for (let i = 0; i < chunk.length; i += 4) {
            let value = 0;
            for (let j = 0; j < 4; j++) {
                value = value * 256 + (chunk[i + j] ?? 0);
            }
            let encoded = '';
            for (let j = 0; j < 5; j++) {
                encoded = alphabet[value % 85] + encoded;
                value = Math.floor(value / 85);
            }
            row += encoded;
        }
        rows.push(row);
    }
    return `literal ${content.length}\n${rows.join('\n')}\n\n`;
}

function binaryDiff(): string {
    return 'diff --git a/picture.bin b/picture.bin\nindex 1111111..2222222 100644\nGIT binary patch\n'
        + binaryBlock(Buffer.from([0, 1, 2])) + binaryBlock(Buffer.from([0, 3, 4]));
}

function contentBytes(bytes: Buffer): number {
    return parseHunks(bytes).reduce(
        (total, part) => total + part.files.reduce(
            (size, file) => size + (file.before?.length ?? 0) + (file.after?.length ?? 0), 0,
        ), 0,
    );
}

describe('splitPatchMessages', () => {
    test('splits ordered subject-only envelopes without inventing commits, authors, or dates', () => {
        const first = subjectOnlyMail('0001-first.diff',
            '--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-zero\n+one\n\n');
        const second = subjectOnlyMail('0002-second.diff',
            '--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-one\n+two\n\n');
        for (const ending of ['\n', '\r\n']) {
            const expected = [first, second].map(text => Buffer.from(text.replace(/\n/g, ending)));
            const input = Buffer.concat(expected);
            const messages = splitPatchMessages(input);
            assert.equal(messages.length, 2);
            assert.deepEqual(messages.map(message => message.bytes), expected);
            assert.deepEqual(messages.map(message => message.metadata.subject),
                ['0001-first.diff', '0002-second.diff']);
            assert.deepEqual(messages.map(message => message.hasDiff), [true, true]);
            for (const message of messages) {
                assert.equal(message.metadata.commit, undefined);
                assert.equal(message.metadata.author, undefined);
                assert.equal(message.metadata.date, undefined);
            }
            assert.deepEqual(Buffer.concat(messages.map(message => message.bytes)), input);
            const parts = parseHunks(input);
            assert.equal(parts.length, 2);
            assert.equal(parts[0].metadata.subject, '0001-first.diff');
            assert.equal(parts[1].metadata.subject, '0002-second.diff');
            assert.match(parts[0].files[0].before?.toString() ?? '', /\nzero\r?\n$/);
            assert.match(parts[0].files[0].after?.toString() ?? '', /\none\r?\n$/);
            assert.match(parts[1].files[0].before?.toString() ?? '', /\none\r?\n$/);
            assert.match(parts[1].files[0].after?.toString() ?? '', /\ntwo\r?\n$/);
        }
    });

    test('does not split subject-only envelope text in context, removed, or added hunk lines', () => {
        const envelope = `From ${'0'.repeat(40)} Mon Sep 17 00:00:00 2001`;
        const body = [
            '@@ -1,6 +1,6 @@',
            ` ${envelope}`,
            ' Subject: context.diff',
            ' ',
            `-${envelope}`,
            '-Subject: removed.diff',
            '-',
            `+${envelope}`,
            '+Subject: added.diff',
            '+',
            '',
        ].join('\n');
        const first = subjectOnlyMail('0001-first.diff', diff(body));
        const second = subjectOnlyMail('0002-second.diff', diff());
        const messages = splitPatchMessages(Buffer.from(first + second));
        assert.equal(messages.length, 2);
        assert.deepEqual(messages.map(message => message.metadata.subject),
            ['0001-first.diff', '0002-second.diff']);
        assert.deepEqual(messages[0].bytes, Buffer.from(first));
        assert.equal(onlyFile(messages[0].bytes).hasHunks, true);
    });

    test('still requires a terminated mail header block for a subject-only boundary', () => {
        const fake = `From ${'0'.repeat(40)} Mon Sep 17 00:00:00 2001\n`
            + 'Subject: not-a-boundary.diff\nThis is not a blank header terminator.\n\n';
        const input = Buffer.from(subjectOnlyMail('0001-first.diff', fake + diff()));
        const messages = splitPatchMessages(input);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].metadata.subject, '0001-first.diff');
        assert.deepEqual(messages[0].bytes, input);
    });

    test('preserves a cover letter, message order, signatures, and every byte', () => {
        const cover = mail('[PATCH 0/2] Sample series', `Introduction.\n\n${SIGNATURE}`, '0'.repeat(40));
        const first = mail('[PATCH 1/2] First change', diff() + SIGNATURE);
        const second = mail('[PATCH 2/2] Second change', diff(undefined, 'second.txt') + SIGNATURE, SECOND);
        const input = Buffer.from(cover + first + second);
        const messages = splitPatchMessages(input);
        assert.equal(messages.length, 3);
        assert.deepEqual(messages.map(message => message.hasDiff), [false, true, true]);
        assert.deepEqual(messages.map(message => message.metadata.commit), [undefined, FIRST, SECOND]);
        assert.deepEqual(messages.map(message => message.metadata.index), [0, 1, 2]);
        assert.deepEqual(messages.map(message => message.metadata.total), [2, 2, 2]);
        assert.equal(messages[1].metadata.subject, '[PATCH 1/2] First change');
        assert.equal(messages[1].metadata.author, 'Sample Author <author@example.test>');
        assert.equal(messages[1].metadata.date, DATE);
        assert.deepEqual(Buffer.concat(messages.map(message => message.bytes)), input);
        assert.deepEqual(messages.map(message => message.bytes), [cover, first, second].map(text => Buffer.from(text)));
    });

    test('handles folded headers, adjacent encoded words, and carriage-return/newline mail', () => {
        const input = Buffer.from(mail(
            '[PATCH v3 1/2] =?UTF-8?B?Y2Fmw6k=?=\n\t=?UTF-8?Q?_change?=',
            diff(),
        ).replace(/\n/g, '\r\n'));
        const [message] = splitPatchMessages(input);
        assert.equal(message.metadata.subject, '[PATCH v3 1/2] café change');
        assert.equal(message.metadata.index, 1);
        assert.equal(message.metadata.total, 2);
        assert.deepEqual(message.bytes, input);
    });

    test('keeps malformed encoded words literal rather than silently corrupting them', () => {
        const [message] = splitPatchMessages(Buffer.from(mail('[PATCH] =?UTF-8?Q?bad=XX?=', diff())));
        assert.equal(message.metadata.subject, '[PATCH] =?UTF-8?Q?bad=XX?=');
    });

    test('does not split envelopes or diff-like headers inside hunk content', () => {
        const body = [
            '@@ -1,8 +1,8 @@',
            ` From ${SECOND} Mon Sep 17 00:00:00 2001`,
            ' From: Other <other@example.test>',
            ` Date: ${DATE}`,
            ' Subject: [PATCH 2/2] Not a message',
            ' ',
            ' diff --git a/false b/false',
            ' --- a/false',
            ' +++ b/false',
            '',
        ].join('\n');
        const messages = splitPatchMessages(Buffer.from(mail('[PATCH] Real subject', diff(body))));
        assert.equal(messages.length, 1);
        assert.equal(messages[0].metadata.subject, '[PATCH] Real subject');
        assert.equal(onlyFile(messages[0].bytes).hasHunks, true);
    });

    test('requires a complete envelope and mail header block for a subsequent boundary', () => {
        const fake = [
            `From ${SECOND} Mon Sep 17 not a timestamp`,
            'From: Other <other@example.test>',
            `Date: ${DATE}`,
            'Subject: [PATCH] Not an envelope',
            '',
            `From ${SECOND} Mon Sep 17 00:00:00 2001`,
            'This is body text, not headers.',
            '',
        ].join('\n');
        const input = Buffer.from(mail('[PATCH] One', fake + diff()));
        assert.equal(splitPatchMessages(input).length, 1);
    });

    test('treats a plain diff, a unified diff, and git show as single messages', () => {
        for (const text of [diff(), '--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-old\n+new\n']) {
            const [message] = splitPatchMessages(Buffer.from(text));
            assert.equal(message.hasDiff, true);
            assert.equal(message.metadata.commit, undefined);
        }
        const show = `commit ${FIRST} (HEAD -> sample)\nAuthor: A <a@example.test>\nDate:   ${DATE}\n`
            + `\n    Subject from show\n\n${diff()}`;
        const [message] = splitPatchMessages(Buffer.from(show));
        assert.equal(message.metadata.commit, FIRST);
        assert.equal(message.metadata.author, 'A <a@example.test>');
        assert.equal(message.metadata.date, DATE);
        assert.equal(message.metadata.subject, 'Subject from show');
    });

    test('does not turn a later envelope in plain git show output into a series', () => {
        const text = `commit ${FIRST}\nAuthor: A\n\n    A subject\n\n${diff()}`
            + mail('[PATCH] Not a second show record', diff(), SECOND);
        assert.equal(splitPatchMessages(Buffer.from(text)).length, 1);
    });

    test('supports abbreviated git show commits and keeps compatibility header detection', () => {
        assert.equal(splitPatchMessages(Buffer.from('commit abcdef1\n'))[0].metadata.commit, 'abcdef1');
        assert.equal(splitPatchMessages(Buffer.from('commit abcdef\n'))[0].metadata.commit, undefined);
        assert.equal(splitPatchMessages(Buffer.from('From: A\n'))[0].metadata.commit, undefined);
        assert.equal(splitPatchMessages(Buffer.from('diff --git a/x b/x\n'))[0].hasDiff, true);
        assert.equal(splitPatchMessages(Buffer.from('--- a/x\n+++ b/x\n'))[0].hasDiff, true);
    });

    test('does not expose an all-zero envelope or show identifier as a usable commit', () => {
        const zeroes = '0'.repeat(40);
        const envelope = `From ${zeroes} Mon Sep 17 00:00:00 2001\n`;
        assert.equal(splitPatchMessages(Buffer.from(envelope))[0].metadata.commit, undefined);
        assert.equal(splitPatchMessages(Buffer.from(`commit ${zeroes}\n`))[0].metadata.commit, undefined);
        const [cover] = splitPatchMessages(Buffer.from(mail('[PATCH 0/1] Cover', 'Introduction.\n', zeroes)));
        assert.equal(cover.metadata.commit, undefined);
        assert.equal(cover.metadata.index, 0);
    });

    test('retains leading blank lines and a byte-order marker without losing bytes', () => {
        const text = '\uFEFF\n' + mail('[PATCH 1/2] One', diff())
            + mail('[PATCH 2/2] Two', diff(), SECOND);
        const input = Buffer.from(text);
        const messages = splitPatchMessages(input);
        assert.equal(messages.length, 2);
        assert.deepEqual(Buffer.concat(messages.map(message => message.bytes)), input);
    });

    test('preserves binary and non-UTF-8 bytes for the repository-backed consumer', () => {
        const input = Buffer.concat([Buffer.from(mail('[PATCH] Bytes', diff())), Buffer.from([0xff, 0, 0xfe])]);
        const [message] = splitPatchMessages(input);
        assert.equal(message.hasDiff, true);
        assert.deepEqual(message.bytes, input);
        assert.throws(() => parseHunks(input), (error: unknown) =>
            error instanceof PatchParseError && /UTF-8/.test(error.message));
    });

    test('respects Uint8Array offsets and does not include unrelated backing bytes', () => {
        const text = Buffer.from(diff());
        const backing = Buffer.concat([Buffer.from('prefix'), text, Buffer.from('suffix')]);
        const bytes = new Uint8Array(backing.buffer, backing.byteOffset + 6, text.length);
        assert.deepEqual(splitPatchMessages(bytes)[0].bytes, text);
        assert.equal(parseHunks(bytes)[0].files[0].newPath, 'sample.txt');
    });

    test('has no messages for empty input and no diff for ordinary text', () => {
        assert.deepEqual(splitPatchMessages(Buffer.alloc(0)), []);
        assert.equal(splitPatchMessages(Buffer.from('Some notes.\n'))[0].hasDiff, false);
    });
});

describe('parseHunks partial-context rendering', () => {
    test('shows only supplied lines and explicit original/new ranges with omitted-context separators', () => {
        const file = onlyFile(diff('@@ -10,2 +10,2 @@ context\n keep\n-old\n+new\n'
            + '@@ -50 +50 @@\n-later old\n+later new\n'));
        assert.equal(file.status, 'M');
        assert.equal(file.hasHunks, true);
        assert.equal(file.before?.toString(), '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 10-11]\nkeep\nold\n'
            + '[... omitted context between hunks (if any) ...]\n[Original lines 50-50]\nlater old\n');
        assert.equal(file.after?.toString(), '[Partial context only - new side; not a complete file]\n'
            + '[New lines 10-11]\nkeep\nnew\n'
            + '[... omitted context between hunks (if any) ...]\n[New lines 50-50]\nlater new\n');
        assert.equal(file.oldId, '1111111');
        assert.equal(file.newId, '2222222');
        assert.equal(file.oldMode, '100644');
    });

    test('parses standard multi-file unified diffs and tab-separated timestamps', () => {
        const text = '--- before name.txt\t2026-11-09 12:00:00 +0000\n'
            + '+++ after name.txt\t2026-11-09 12:00:01 +0000\n@@ -2 +2 @@\n-old\n+new\n'
            + 'diff -u before/other.txt after/other.txt\n--- before/other.txt\n+++ after/other.txt\n'
            + '@@ -4 +4 @@\n-other\n+updated\n';
        const parts = parseHunks(Buffer.from(text));
        assert.equal(parts[0].files.length, 2);
        assert.equal(parts[0].files[0].oldPath, 'before name.txt');
        assert.equal(parts[0].files[0].newPath, 'after name.txt');
        assert.equal(parts[0].files[1].newPath, 'after/other.txt');
    });

    test('returns separate series parts, including the cover letter, rather than a cumulative file', () => {
        const input = Buffer.from(mail('[PATCH 0/2] Series', 'Cover letter.\n', '0'.repeat(40))
            + mail('[PATCH 1/2] One', diff())
            + mail('[PATCH 2/2] Two', diff('@@ -100 +100 @@\n-new\n+newer\n'), SECOND));
        const parts = parseHunks(input);
        assert.equal(parts.length, 3);
        assert.deepEqual(parts.map(part => part.files.length), [0, 1, 1]);
        assert.match(parts[1].files[0].after?.toString() ?? '', /\nnew\n$/);
        assert.match(parts[2].files[0].before?.toString() ?? '', /Original lines 100-100/);
        assert.doesNotMatch(parts[2].files[0].before?.toString() ?? '', /\nold\n/);
    });

    test('does not read a mail signature or its version as hunk data', () => {
        const file = onlyFile(mail('[PATCH] Subject', diff() + SIGNATURE + 'Other footer text\n'));
        assert.match(file.before?.toString() ?? '', /\nold\n$/);
        assert.match(file.after?.toString() ?? '', /\nnew\n$/);
        assert.doesNotMatch(file.after?.toString() ?? '', /2\.45|footer|-- /);
    });

    test('preserves observed carriage-return/newline line endings in hunk content', () => {
        const file = onlyFile(mail('[PATCH] Subject', diff() + SIGNATURE).replace(/\n/g, '\r\n'));
        assert.match(file.before?.toString() ?? '', /\nold\r\n$/);
        assert.match(file.after?.toString() ?? '', /\nnew\r\n$/);
    });

    test('honors no-newline markers separately on both sides', () => {
        const file = onlyFile(diff('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n'
            + '+new\n\\ No newline at end of file'));
        assert.match(file.before?.toString() ?? '', /\nold$/);
        assert.match(file.after?.toString() ?? '', /\nnew$/);
        assert.doesNotMatch(file.after?.toString() ?? '', /\\ No newline/);
    });

    test('handles a no-newline context row and a missing final patch newline', () => {
        const context = onlyFile(diff('@@ -1 +1 @@\n same\n\\ No newline at end of file\n'));
        assert.match(context.before?.toString() ?? '', /\nsame$/);
        assert.match(context.after?.toString() ?? '', /\nsame$/);
        const final = onlyFile(diff('@@ -1 +1 @@\n-old\n+new'));
        assert.match(final.after?.toString() ?? '', /\nnew$/);
    });

    test('does not mistake header-like payload for file headers, hunks, or trailers', () => {
        const text = '@@ -1,5 +1,5 @@\n--- a/not-a-file\n+++ b/not-a-file\n'
            + ' @@ -9 +9 @@\n diff --git a/not-a-file b/not-a-file\n -- \n Subject: not mail\n';
        const file = onlyFile(diff(text));
        assert.match(file.before?.toString() ?? '', /\n-- a\/not-a-file\n/);
        assert.match(file.after?.toString() ?? '', /\n\+\+ b\/not-a-file\n/);
        assert.match(file.after?.toString() ?? '', /\ndiff --git a\/not-a-file b\/not-a-file\n/);
    });

    test('shows a zero-line anchor for a middle-of-file insertion without padding', () => {
        const file = onlyFile(diff('@@ -42,0 +43,2 @@\n+one\n+two\n'));
        assert.match(file.before?.toString() ?? '', /\[Original lines none \(anchor 42\)\]\n$/);
        assert.match(file.after?.toString() ?? '', /\[New lines 43-44\]\none\ntwo\n$/);
    });

    test('accepts a zero-line anchor immediately after a preceding nonempty hunk', () => {
        const file = onlyFile(diff('@@ -1 +1 @@\n-old\n+new\n@@ -1,0 +2 @@\n+extra\n'));
        assert.match(file.before?.toString() ?? '', /Original lines none \(anchor 1\)/);
        assert.match(file.after?.toString() ?? '', /\nextra\n$/);
    });
});

describe('parseHunks file kinds and names', () => {
    test('handles additions and deletions without inventing an absent side', () => {
        const added = onlyFile('diff --git a/new.txt b/new.txt\nnew file mode 100644\n'
            + 'index 0000000..1111111\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');
        assert.equal(added.status, 'A');
        assert.equal(added.before, undefined);
        assert.equal(added.oldPath, 'new.txt');
        assert.equal(added.newPath, 'new.txt');
        assert.equal(added.newMode, '100644');
        assert.match(added.after?.toString() ?? '', /New lines 1-2/);
        const deleted = onlyFile('--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n');
        assert.equal(deleted.status, 'D');
        assert.equal(deleted.oldPath, 'gone.txt');
        assert.equal(deleted.newPath, 'gone.txt');
        assert.equal(deleted.after, undefined);
    });

    test('handles edited renames, pure renames, and copies', () => {
        const prefix = 'diff --git a/old name.txt b/new name.txt\nsimilarity index 80%\n'
            + 'rename from old name.txt\nrename to new name.txt\n';
        const renamed = onlyFile(prefix + 'index 1111111..2222222 100644\n'
            + '--- a/old name.txt\n+++ b/new name.txt\n@@ -1 +1 @@\n-old\n+new\n');
        assert.equal(renamed.status, 'R');
        assert.equal(renamed.oldPath, 'old name.txt');
        assert.equal(renamed.newPath, 'new name.txt');
        assert.equal(renamed.hasHunks, true);
        const pure = onlyFile(prefix.replace('80%', '100%'));
        assert.equal(pure.status, 'R');
        assert.equal(pure.hasHunks, false);
        assert.match(pure.before?.toString() ?? '', /no text hunks supplied/);
        const copy = onlyFile(prefix.replace(/rename/g, 'copy'));
        assert.equal(copy.status, 'C');
        assert.equal(copy.hasHunks, false);
    });

    test('handles executable mode changes and file-type changes', () => {
        const executable = onlyFile('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n');
        assert.equal(executable.status, 'M');
        assert.equal(executable.oldMode, '100644');
        assert.equal(executable.newMode, '100755');
        assert.equal(executable.hasHunks, false);
        const type = onlyFile(diff(undefined, 'link', 'old mode 100644\nnew mode 120000\n'
            + 'index 1111111..2222222\n'));
        assert.equal(type.status, 'T');
    });

    test('handles metadata-only creation and deletion of empty files', () => {
        const added = onlyFile('diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n');
        assert.equal(added.status, 'A');
        assert.equal(added.hasHunks, false);
        assert.equal(added.before, undefined);
        assert.match(added.after?.toString() ?? '', /line ranges unavailable/);
        const deleted = onlyFile('diff --git a/empty b/empty\ndeleted file mode 100644\n'
            + 'index e69de29..0000000\n');
        assert.equal(deleted.status, 'D');
        assert.equal(deleted.after, undefined);
    });

    test('shows supplied submodule pointers without claiming to materialize their contents', () => {
        const file = onlyFile(diff(`@@ -1 +1 @@\n-Subproject commit ${FIRST}\n+Subproject commit ${SECOND}\n`,
            'vendor/sample', 'index 1111111..2222222 160000\n'));
        assert.equal(file.oldMode, '160000');
        assert.equal(file.newMode, '160000');
        assert.match(file.before?.toString() ?? '', new RegExp(`Subproject commit ${FIRST}`));
        assert.match(file.after?.toString() ?? '', /Partial context only/);
    });

    test('labels Git binary payloads honestly without reconstructing or displaying encoded data', () => {
        const file = onlyFile(binaryDiff());
        assert.equal(file.binary, true);
        assert.equal(file.hasHunks, false);
        assert.equal(file.oldId, '1111111');
        assert.match(file.before?.toString() ?? '', /binary payload is not reconstructed/);
        assert.match(file.after?.toString() ?? '', /New line ranges unavailable/);
        assert.doesNotMatch(file.after?.toString() ?? '', /literal|delta|GIT binary patch/);
    });

    test('accepts a binary summary and absent sides in a binary addition', () => {
        const summary = onlyFile('diff --git a/picture.bin b/picture.bin\n'
            + 'index 1111111..2222222 100644\nBinary files a/picture.bin and b/picture.bin differ\n');
        assert.equal(summary.binary, true);
        const added = onlyFile(binaryDiff().replace(
            'index 1111111..2222222 100644', 'new file mode 100644\nindex 0000000..2222222',
        ));
        assert.equal(added.status, 'A');
        assert.equal(added.before, undefined);
        assert.equal(added.binary, true);
    });

    test('does not allocate from a binary literal declaration', () => {
        const huge = binaryDiff().replace('literal 3', 'literal 9007199254740991');
        assert.equal(onlyFile(huge).hasHunks, false);
    });

    test('accepts delta blocks and full-width encoded binary rows without decoding them', () => {
        const delta = binaryBlock(Buffer.from([3, 3, 0x90, 3])).replace('literal 4', 'delta 4');
        const content = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
        const text = 'diff --git a/data.bin b/data.bin\nindex 1111111..2222222 100644\nGIT binary patch\n'
            + delta + binaryBlock(content);
        assert.equal(onlyFile(text).binary, true);
    });

    test('supports unquoted spaces, repeated b/ components, and non-ASCII names', () => {
        for (const path of ['a name with spaces.txt', 'dir b/leaf b/file.txt', 'café.txt']) {
            const file = onlyFile(diff(undefined, path));
            assert.equal(file.oldPath, path);
            assert.equal(file.newPath, path);
        }
        const mode = onlyFile('diff --git a/dir b/leaf b/file b/dir b/leaf b/file\n'
            + 'old mode 100644\nnew mode 100755\n');
        assert.equal(mode.oldPath, 'dir b/leaf b/file');
        assert.equal(mode.newPath, 'dir b/leaf b/file');
    });

    test('decodes Git C-style quoted paths, octal UTF-8 bytes, quotes, and tabs', () => {
        const old = String.raw`"a/caf\303\251 \"sample\"\t.txt"`;
        const next = String.raw`"b/caf\303\251 \"sample\"\t.txt"`;
        const text = `diff --git ${old} ${next}\nindex 1111111..2222222 100644\n`
            + `--- ${old}\n+++ ${next}\n@@ -1 +1 @@\n-old\n+new\n`;
        const file = onlyFile(text);
        assert.equal(file.oldPath, 'café "sample"\t.txt');
        assert.equal(file.newPath, 'café "sample"\t.txt');
    });

    test('does not strip literal a/ and b/ directory names from rename metadata', () => {
        const file = onlyFile('diff --git a/a/old b/b/new\nsimilarity index 100%\n'
            + 'rename from a/old\nrename to b/new\n');
        assert.equal(file.oldPath, 'a/old');
        assert.equal(file.newPath, 'b/new');
    });

    test('preserves literal prefix-like directories in git diffs generated without prefixes', () => {
        const modified = onlyFile('diff --git a/file.txt a/file.txt\nindex 1111111..2222222 100644\n'
            + '--- a/file.txt\n+++ a/file.txt\n@@ -1 +1 @@\n-old\n+new\n');
        assert.equal(modified.oldPath, 'a/file.txt');
        assert.equal(modified.newPath, 'a/file.txt');
        const added = onlyFile('diff --git b/file.txt b/file.txt\nnew file mode 100644\n'
            + 'index 0000000..1111111\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+new\n');
        assert.equal(added.newPath, 'b/file.txt');
    });
});

describe('parseHunks validation', () => {
    const malformed: readonly [string, string, RegExp][] = [
        ['missing new header', '--- old.txt\n@@ -1 +1 @@\n-old\n+new\n', /followed by a \+\+\+/],
        ['missing file headers', '@@ -1 +1 @@\n-old\n+new\n', /no file headers/],
        ['malformed hunk header', diff('@@ -one +1 @@\n-old\n+new\n'), /Malformed hunk/],
        ['truncated hunk', diff('@@ -1,2 +1,2 @@\n one\n'), /Truncated hunk/],
        ['too many old lines', diff('@@ -1,0 +1 @@\n-old\n+new\n'), /exceeds/],
        ['too many new lines', diff('@@ -1 +1,0 @@\n+new\n-old\n'), /exceeds/],
        ['extra content after hunk', diff() + '+extra\n', /Unexpected patch content/],
        ['unprefixed blank hunk row', diff('@@ -1,2 +1,2 @@\n same\n\n'), /Truncated hunk/],
        ['zero start with nonzero count', diff('@@ -0 +1 @@\n-old\n+new\n'), /line range/],
        ['empty hunk', diff('@@ -0,0 +0,0 @@\n'), /at least one line/],
        ['unsafe hunk count', diff('@@ -1,9007199254740992 +1 @@\n'), /line range/],
        ['overlapping hunks', diff('@@ -2 +2 @@\n-old\n+new\n@@ -2 +2 @@\n-old\n+new\n'), /overlap/],
        ['no hunks after file headers', diff(''), /no hunks/],
        ['bare diff header', 'diff --git a/x b/x\n', /no changes/],
        ['missing git paths', 'diff --git\n', /Missing file paths/],
        ['index without changes', 'diff --git a/x b/x\nindex 1111111..2222222 100644\n', /no changes/],
        ['incomplete rename', 'diff --git a/x b/y\nrename from x\n', /Incomplete/],
        ['incomplete mode', 'diff --git a/x b/x\nold mode 100644\n', /Incomplete/],
        ['invalid mode', 'diff --git a/x b/x\nold mode 100888\nnew mode 100755\n', /Malformed/],
        ['invalid index', 'diff --git a/x b/x\nindex not-an-object\n', /Malformed/],
        ['invalid similarity', 'diff --git a/x b/y\nsimilarity index 101%\n', /exceeds 100/],
        ['contradictory status', 'diff --git a/x b/x\nnew file mode 100644\ndeleted file mode 100644\n',
            /Contradictory/],
        ['absent old side with lines', '--- /dev/null\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', /absent side/],
        ['both sides absent', '--- /dev/null\n+++ /dev/null\n@@ -1 +1 @@\n-old\n+new\n', /Both file sides/],
        ['misplaced marker', diff('@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n'), /Misplaced/],
        ['marker before end of side', diff('@@ -1,2 +1 @@\n-old\n\\ No newline at end of file\n'), /Misplaced/],
        ['repeated marker', diff('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n'
            + '\\ No newline at end of file\n'), /Misplaced/],
        ['hunk after end of file', diff('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n'
            + '@@ -4 +4 @@\n-old\n+new\n'), /no-newline marker/],
        ['truncated mail before signature', mail('[PATCH] Truncated',
            diff('@@ -1,2 +1 @@\n-old\n+new\n') + SIGNATURE), /Unexpected patch content|Truncated/],
        ['binary block missing', 'diff --git a/x b/x\nGIT binary patch\n', /no literal or delta/],
        ['binary payload missing', 'diff --git a/x b/x\nGIT binary patch\nliteral 5\n\n', /no payload/],
        ['binary row truncated', 'diff --git a/x b/x\nGIT binary patch\nliteral 5\nAabcd\n\n', /payload/],
        ['binary row invalid', 'diff --git a/x b/x\nGIT binary patch\nliteral 5\nA/////\n\n', /payload/],
    ];
    for (const [name, text, message] of malformed) {
        test(`rejects ${name} explicitly`, () => {
            assert.throws(() => parseHunks(Buffer.from(text)), (error: unknown) =>
                error instanceof PatchParseError && message.test(error.message));
        });
    }

    for (const header of ['diff --cc sample.txt\n', 'diff --combined sample.txt\n', '@@@ -1 -1 +1 @@@\n']) {
        test(`rejects combined diff form ${header.trim()}`, () => {
            assert.throws(() => parseHunks(Buffer.from(header)), /Combined merge diffs are unsupported/);
        });
    }

    for (const path of [String.raw`"a/bad\q"`, String.raw`"a/bad\777"`, String.raw`"a/bad\377"`,
        String.raw`"a/bad\000"`, '"a/unclosed', '""']) {
        test(`rejects invalid quoted path ${path}`, () => {
            assert.throws(
                () => parseHunks(Buffer.from(`diff --git ${path} b/x\nold mode 100644\nnew mode 100755\n`)),
                PatchParseError,
            );
        });
    }

    test('rejects empty or ordinary text instead of returning success-shaped empty parts', () => {
        for (const text of ['', '\n \n', 'Ordinary notes.\n', mail('[PATCH 0/1] Only a cover', 'Introduction.\n')]) {
            assert.throws(() => parseHunks(Buffer.from(text)), /no supported file diffs/);
        }
    });
});

describe('parseHunks limits and cancellation', () => {
    test('honors the exact input byte boundary, not the character count', () => {
        const input = Buffer.from(diff('@@ -1 +1 @@\n-café\n+thé\n'));
        assert.equal(parseHunks(input, { maxPatchBytes: input.length }).length, 1);
        assert.throws(() => parseHunks(input, { maxPatchBytes: input.length - 1 }), OperationLimitError);
    });

    test('uses the exact default input limit and rejects excess bytes before text decoding', () => {
        const patch = Buffer.from(diff());
        const padding = Buffer.alloc(DEFAULT_MAX_PATCH_BYTES - patch.length, 0x78);
        padding[padding.length - 1] = 0x0a;
        const input = Buffer.concat([padding, patch]);
        assert.equal(parseHunks(input).length, 1);
        assert.throws(() => parseHunks(Buffer.alloc(DEFAULT_MAX_PATCH_BYTES + 1, 0xff)), OperationLimitError);
    });

    test('counts both sides, labels, placeholders, and every message in the content byte limit', () => {
        const bytes = Buffer.from(mail('[PATCH 1/2] One', diff('@@ -1 +1 @@\n-café\n+thé\n'))
            + mail('[PATCH 2/2] Two', binaryDiff(), SECOND));
        const size = contentBytes(bytes);
        assert.equal(parseHunks(bytes, { maxContentBytes: size }).length, 2);
        assert.throws(() => parseHunks(bytes, { maxContentBytes: size - 1 }), OperationLimitError);
    });

    test('uses final no-newline sizes rather than transient line-ending bytes', () => {
        const bytes = Buffer.from(diff('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n'
            + '+new\n\\ No newline at end of file\n'));
        const size = contentBytes(bytes);
        assert.equal(parseHunks(bytes, { maxContentBytes: size }).length, 1);
        assert.throws(() => parseHunks(bytes, { maxContentBytes: size - 1 }), OperationLimitError);
    });

    test('rejects tiny content limits before materializing an oversized side', () => {
        assert.throws(() => parseHunks(Buffer.from(diff()), { maxContentBytes: 1 }), OperationLimitError);
    });

    test('handles many short context rows without allocating a separate output buffer per row', () => {
        const rows = 100_000;
        const bytes = Buffer.from(diff(`@@ -1,${rows} +1,${rows} @@\n${' \n'.repeat(rows)}`));
        const size = contentBytes(bytes);
        assert.equal(parseHunks(bytes, { maxContentBytes: size }).length, 1);
        assert.throws(() => parseHunks(bytes, { maxContentBytes: size - 1 }), OperationLimitError);
    });

    test('handles many quoted escapes without a separate allocation for every escape', () => {
        const escaped = String.raw`\141`.repeat(32_768);
        const file = onlyFile(`diff --git "a/${escaped}" "b/${escaped}"\nold mode 100644\nnew mode 100755\n`);
        assert.equal(file.oldPath, 'a'.repeat(32_768));
    });

    test('validates configured limits', () => {
        for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => parseHunks(Buffer.from(diff()), { maxPatchBytes: limit }), /positive whole number/);
            assert.throws(() => parseHunks(Buffer.from(diff()), { maxContentBytes: limit }), /positive whole number/);
        }
    });

    test('uses the shared typed cancellation error before parsing', () => {
        const controller = new AbortController();
        controller.abort();
        assert.throws(
            () => parseHunks(Buffer.from(diff()), { signal: controller.signal }),
            OperationCancelledError,
        );
    });

    test('checks for cancellation while scanning and rendering, not only on entry', () => {
        const controller = new AbortController();
        let checks = 0;
        const signal = new Proxy(controller.signal, {
            get(target, key) {
                return key === 'aborted' ? ++checks > 20 : Reflect.get(target, key, target);
            },
        });
        const rows = Array.from({ length: 20 }, (_, i) => ` line ${i}\n`).join('');
        assert.throws(
            () => parseHunks(Buffer.from(diff(`@@ -1,20 +1,20 @@\n${rows}`)), { signal }),
            OperationCancelledError,
        );
        assert.ok(checks > 20);
    });

    test('checks for cancellation within a large quoted path, including multi-character escape steps', () => {
        let checks = 0;
        const signal = new Proxy(new AbortController().signal, {
            get(target, key) {
                return key === 'aborted' ? ++checks > 10 : Reflect.get(target, key, target);
            },
        });
        const escaped = String.raw`\141`.repeat(32_768);
        const bytes = Buffer.from(`diff --git "a/${escaped}" "b/${escaped}"\nold mode 100644\nnew mode 100755\n`);
        assert.throws(() => parseHunks(bytes, { signal }), OperationCancelledError);
        assert.ok(checks > 10);
    });
});
