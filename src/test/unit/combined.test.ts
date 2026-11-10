import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OperationCancelledError, OperationLimitError } from '../../operations';
import {
    CombinedFile,
    hasCombinedDiff,
    parseCombinedParts,
    parseHunks,
    PatchParseError,
    splitPatchMessages,
} from '../../patchText';

const FIRST = '1234567890abcdef1234567890abcdef12345678';
const DATE = 'Mon, 9 Nov 2026 12:00:00 +0000';

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

// Fixtures transcribed verbatim from `git show --cc` / `git show -c` output of real merges,
// cross-checked against the COMBINED DIFF FORMAT section of the git-diff documentation.
const MODIFIED = [
    'diff --cc f.txt',
    'index 61ca839,68ddb7a..6085bc4',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@@ -1,3 -1,3 +1,3 @@@',
    '  alpha',
    '- ours',
    ' -theirs',
    '++merged',
    '  omega',
    '',
].join('\n');

const ADDED = [
    'diff --cc added.txt',
    'index 0000000,0000000..76e25e1',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@@ -1,0 -1,0 +1,2 @@@',
    '++brand new',
    '++in merge',
    '',
].join('\n');

const DELETED = [
    'diff --cc del.txt',
    'index 25d3f6b,6a6f653..0000000',
    'deleted file mode 100644,100644',
    '--- a/del.txt',
    '+++ /dev/null',
    '@@@ -1,2 -1,2 +1,0 @@@',
    '--keep',
    '- gone c',
    ' -gone b',
    '',
].join('\n');

const MODE = [
    'diff --cc mode.txt',
    'index c376d89,45cf141..f7bf1cb',
    'mode 100644,100644..100755',
    '--- a/mode.txt',
    '+++ b/mode.txt',
    '@@@ -1,1 -1,1 +1,1 @@@',
    '- right',
    ' -left',
    '++MERGED',
    '',
].join('\n');

const OCTOPUS = [
    'diff --combined o.txt',
    'index 4099c9f,91c0e8d,f67299a..34aa3ea',
    '--- a/o.txt',
    '+++ b/o.txt',
    '@@@@ -1,5 -1,5 -1,5 +1,5 @@@@',
    '   line 1',
    ' --line 2',
    ' ++EDIT-A',
    '   line 3',
    '   line 4',
    '   line 5',
    '@@@@ -12,7 -12,7 -12,7 +12,7 @@@@ line 1',
    '   line 12',
    '   line 13',
    '   line 14',
    '- -line 15',
    '+ +EDIT-B',
    '   line 16',
    '   line 17',
    '   line 18',
    '@@@@ -25,6 -25,6 -25,6 +25,6 @@@@ line 2',
    '   line 25',
    '   line 26',
    '   line 27',
    '-- line 28',
    '++ EDIT-C',
    '   line 29',
    '   line 30',
    '',
].join('\n');

const ORDINARY = 'diff --git a/sample.txt b/sample.txt\nindex 1111111..2222222 100644\n'
    + '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n';

function onlyCombined(text: string): CombinedFile {
    const parts = parseCombinedParts(Buffer.from(text));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].files.length, 1);
    return parts[0].files[0];
}

describe('hasCombinedDiff', () => {
    test('detects diff --cc and --combined headers and well-formed @@@ hunks', () => {
        for (const text of [MODIFIED, ADDED, DELETED, OCTOPUS, 'diff --cc x\n', 'diff --combined x\n',
            '@@@ -1,2 -1,2 +1,3 @@@\n', mail('[PATCH] Merge', MODIFIED)]) {
            assert.equal(hasCombinedDiff(Buffer.from(text)), true, text.slice(0, 40));
        }
    });

    test('ignores literal @@@ text inside ordinary hunk lines and malformed headers', () => {
        const inContext = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n'
            + ' @@@ -1,2 -1,2 +1,3 @@@\n-old\n+new\n';
        const inAdded = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n'
            + '-old\n+@@@ -1,2 -1,2 +1,3 @@@\n';
        for (const text of [ORDINARY, inContext, inAdded, '@@@ notes @@@\n', '@@@ -1,2 +1,3 @@\n',
            '@@@@ -1,2 -1,2 +1,3 @@@@\n', 'Use @@@ markers\n', '']) {
            assert.equal(hasCombinedDiff(Buffer.from(text)), false, text.slice(0, 40));
        }
    });
});

describe('parseCombinedParts per-parent views', () => {
    test('splits a two-parent conflict resolution into honest per-parent sides', () => {
        const file = onlyCombined(MODIFIED);
        assert.equal(file.path, 'f.txt');
        assert.equal(file.parents, 2);
        assert.equal(file.perParent.length, 2);
        const [ours, theirs] = file.perParent;
        assert.equal(ours.status, 'M');
        assert.equal(ours.oldPath, 'f.txt');
        assert.equal(ours.newPath, 'f.txt');
        assert.equal(ours.oldId, '61ca839');
        assert.equal(ours.newId, '6085bc4');
        assert.equal(ours.hasHunks, true);
        assert.equal(ours.before?.toString(),
            '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 1-3]\nalpha\nours\nomega\n');
        assert.equal(ours.after?.toString(),
            '[Partial context only - new side; not a complete file]\n'
            + '[New lines 1-3]\nalpha\nmerged\nomega\n');
        assert.equal(theirs.oldId, '68ddb7a');
        assert.equal(theirs.before?.toString(),
            '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 1-3]\nalpha\ntheirs\nomega\n');
        assert.deepEqual(theirs.after, ours.after);
        assert.doesNotMatch(ours.before?.toString() ?? '', /theirs|merged/);
        assert.doesNotMatch(theirs.before?.toString() ?? '', /\bours\b|merged/);
    });

    test('preserves carriage-return/newline endings in per-parent content', () => {
        const file = onlyCombined(MODIFIED.replace(/\n/g, '\r\n'));
        assert.match(file.perParent[0].before?.toString() ?? '', /\nours\r\n/);
        assert.match(file.perParent[1].after?.toString() ?? '', /\nmerged\r\n/);
    });

    test('handles a file added by the merge without inventing parent sides', () => {
        const file = onlyCombined(ADDED);
        assert.equal(file.parents, 2);
        for (const parent of file.perParent) {
            assert.equal(parent.status, 'A');
            assert.equal(parent.before, undefined);
            assert.equal(parent.oldMode, '000000');
            assert.equal(parent.newMode, '100644');
            assert.equal(parent.newId, '76e25e1');
            assert.equal(parent.after?.toString(),
                '[Partial context only - new side; not a complete file]\n'
                + '[New lines 1-2]\nbrand new\nin merge\n');
        }
        assert.deepEqual(file.perParent.map(parent => parent.oldId), ['0000000', '0000000']);
    });

    test('handles a file deleted by the merge with per-parent old sides only', () => {
        const file = onlyCombined(DELETED);
        const [first, second] = file.perParent;
        assert.equal(first.status, 'D');
        assert.equal(first.after, undefined);
        assert.equal(first.oldMode, '100644');
        assert.equal(first.newMode, '000000');
        assert.equal(first.before?.toString(),
            '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 1-2]\nkeep\ngone c\n');
        assert.equal(second.before?.toString(),
            '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 1-2]\nkeep\ngone b\n');
    });

    test('surfaces combined mode lines as per-parent mode metadata', () => {
        const file = onlyCombined(MODE);
        for (const parent of file.perParent) {
            assert.equal(parent.oldMode, '100644');
            assert.equal(parent.newMode, '100755');
            assert.equal(parent.status, 'M');
        }
        assert.match(file.perParent[0].before?.toString() ?? '', /\nright\n/);
        assert.match(file.perParent[1].before?.toString() ?? '', /\nleft\n/);
    });

    test('reports a type change versus only the parents whose mode kind differs', () => {
        const text = 'diff --cc link.txt\nindex 1111111,2222222..3333333\nmode 100644,120000..120000\n'
            + '--- a/link.txt\n+++ b/link.txt\n@@@ -1,1 -1,1 +1,1 @@@\n- old content\n -target\n++new target\n';
        const file = onlyCombined(text);
        assert.deepEqual(file.perParent.map(parent => parent.status), ['T', 'M']);
    });

    test('keeps a metadata-only combined mode change explicit without hunks', () => {
        const file = onlyCombined('diff --cc tool.sh\nindex 1234567,1234567..1234567\n'
            + 'mode 100644,100644..100755\n');
        assert.equal(file.perParent[0].hasHunks, false);
        assert.equal(file.perParent[0].oldMode, '100644');
        assert.equal(file.perParent[0].newMode, '100755');
        assert.match(file.perParent[0].before?.toString() ?? '', /no text hunks supplied/);
        assert.match(file.perParent[1].after?.toString() ?? '', /no text hunks supplied/);
    });

    test('maps every @@@@ range and column of a three-parent octopus merge', () => {
        const file = onlyCombined(OCTOPUS);
        assert.equal(file.path, 'o.txt');
        assert.equal(file.parents, 3);
        assert.deepEqual(file.perParent.map(parent => parent.oldId), ['4099c9f', '91c0e8d', 'f67299a']);
        const [p1, p2, p3] = file.perParent.map(parent => ({
            before: parent.before?.toString() ?? '',
            after: parent.after?.toString() ?? '',
        }));
        for (const side of [p1, p2, p3]) {
            assert.match(side.before, /\[Original lines 1-5\]/);
            assert.match(side.before, /\[Original lines 12-18\]/);
            assert.match(side.before, /\[Original lines 25-30\]/);
            assert.match(side.before, /\[\.\.\. omitted context between hunks \(if any\) \.\.\.\]/);
            assert.match(side.after, /\[New lines 12-18\]/);
            for (const kept of ['EDIT-A', 'EDIT-B', 'EDIT-C']) {
                assert.match(side.after, new RegExp(`\\n${kept}\\n`));
            }
            assert.doesNotMatch(side.after, /line 2\n|line 15\n|line 28\n/);
        }
        assert.match(p1.before, /\nEDIT-A\n/);
        assert.doesNotMatch(p1.before, /\nline 2\n/);
        assert.match(p1.before, /\nline 15\n/);
        assert.doesNotMatch(p1.before, /\nEDIT-B\n/);
        assert.match(p1.before, /\nline 28\n/);
        assert.match(p2.before, /\nline 2\n/);
        assert.doesNotMatch(p2.before, /\nEDIT-A\n/);
        assert.match(p2.before, /\nEDIT-B\n/);
        assert.doesNotMatch(p2.before, /\nline 15\n/);
        assert.match(p2.before, /\nline 28\n/);
        assert.match(p3.before, /\nline 2\n/);
        assert.match(p3.before, /\nline 15\n/);
        assert.match(p3.before, /\nEDIT-C\n/);
        assert.doesNotMatch(p3.before, /\nline 28\n/);
    });

    test('reads --combined-all-paths headers into per-parent old names', () => {
        const text = 'diff --combined to.txt\nindex 1111111,2222222..3333333\n'
            + '--- a/from-one.txt\n--- a/from-two.txt\n+++ b/to.txt\n'
            + '@@@ -1,1 -1,1 +1,1 @@@\n--old\n++new\n';
        const file = onlyCombined(text);
        assert.deepEqual(file.perParent.map(parent => parent.oldPath), ['from-one.txt', 'from-two.txt']);
        assert.deepEqual(file.perParent.map(parent => parent.newPath), ['to.txt', 'to.txt']);
        assert.deepEqual(file.perParent.map(parent => parent.status), ['R', 'R']);
    });

    test('treats a per-parent /dev/null old path as an addition versus that parent only', () => {
        const text = 'diff --combined part.txt\nindex 0000000,1234567..89abcde\n'
            + '--- /dev/null\n--- a/part.txt\n+++ b/part.txt\n'
            + '@@@ -1,0 -1,1 +1,1 @@@\n -old\n++new\n';
        const file = onlyCombined(text);
        const [absent, present] = file.perParent;
        assert.equal(absent.status, 'A');
        assert.equal(absent.before, undefined);
        assert.match(absent.after?.toString() ?? '', /\nnew\n$/);
        assert.equal(present.status, 'M');
        assert.match(present.before?.toString() ?? '', /\nold\n$/);
    });

    test('derives asymmetric per-parent ranges and membership from the @@@ header', () => {
        const file = onlyCombined('diff --cc even.txt\nindex 1111111,2222222..3333333\n'
            + '--- a/even.txt\n+++ b/even.txt\n@@@ -1,1 -1,3 +1,2 @@@\n  same\n'
            + '+ kept\n -two-had\n');
        const [one, two] = file.perParent;
        assert.equal(one.before?.toString(),
            '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 1-1]\nsame\n');
        assert.deepEqual(one.after, two.after);
        assert.equal(one.after?.toString(),
            '[Partial context only - new side; not a complete file]\n'
            + '[New lines 1-2]\nsame\nkept\n');
        assert.equal(two.before?.toString(),
            '[Partial context only - original side; not a complete file]\n'
            + '[Original lines 1-3]\nsame\nkept\ntwo-had\n');
    });

    test('parses mail-wrapped combined series with metadata and per-message routing', () => {
        const input = Buffer.from(mail('[PATCH 0/1] Cover', 'About the merge.\n', '0'.repeat(40))
            + mail('[PATCH 1/1] Merge resolution', `${MODIFIED}-- \n2.45.0\n`));
        const messages = splitPatchMessages(input);
        assert.deepEqual(messages.map(message => message.combined), [undefined, true]);
        assert.deepEqual(messages.map(message => message.hasDiff), [false, true]);
        const parts = parseCombinedParts(input);
        assert.equal(parts.length, 2);
        assert.deepEqual(parts.map(part => part.files.length), [0, 1]);
        assert.equal(parts[1].metadata.subject, '[PATCH 1/1] Merge resolution');
        assert.equal(parts[1].metadata.commit, FIRST);
        assert.equal(parts[1].files[0].path, 'f.txt');
    });

    test('does not set the combined flag for ordinary diffs or literal @@@ context', () => {
        const ordinary = Buffer.from(mail('[PATCH] Plain', ORDINARY));
        assert.equal(splitPatchMessages(ordinary)[0].combined, undefined);
        const literal = Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n'
            + ' @@@ -1,2 -1,2 +1,3 @@@\n-old\n+new\n');
        assert.equal(splitPatchMessages(literal)[0].combined, undefined);
    });

    test('parseHunks still rejects combined content so existing consumers are unchanged', () => {
        for (const text of [MODIFIED, OCTOPUS, mail('[PATCH] Merge', MODIFIED)]) {
            assert.throws(() => parseHunks(Buffer.from(text)),
                /Combined merge diffs are unsupported/);
        }
    });

    test('parses multiple combined files in one message', () => {
        const parts = parseCombinedParts(Buffer.from(ADDED + MODIFIED + DELETED));
        assert.equal(parts.length, 1);
        assert.deepEqual(parts[0].files.map(file => file.path), ['added.txt', 'f.txt', 'del.txt']);
    });
});

describe('parseCombinedParts validation and limits', () => {
    const malformed: readonly [string, string, RegExp][] = [
        ['an ordinary git diff', ORDINARY, /not a combined diff/],
        ['an ordinary hunk after combined headers',
            'diff --cc x\nindex 1111111,2222222..3333333\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
            /not a combined diff/],
        ['a combined hunk without a diff header', '@@@ -1,1 -1,1 +1,1 @@@\n  x\n', /no diff --cc/],
        ['mismatched range and @ counts', 'diff --cc x\n@@@ -1,1 +1,1 @@@\n  x\n',
            /do not match the header @ count/],
        ['asymmetric @ runs', 'diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@@\n  x\n',
            /Malformed combined hunk header/],
        ['a line mixing - and + columns', 'diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@\n+-boom\n',
            /mixes - and \+ columns/],
        ['content exceeding declared counts', 'diff --cc x\n@@@ -1,1 -1,1 +1,2 @@@\n  one\n  two\n',
            /exceeds the declared line counts/],
        ['a truncated hunk', 'diff --cc x\n@@@ -1,2 -1,2 +1,2 @@@\n  only\n', /Truncated combined hunk/],
        ['a no-newline marker', 'diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@\n--gone\n'
            + '\\ No newline at end of file\n++kept\n', /no-newline markers/],
        ['a malformed column prefix', 'diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@\nx bad\n',
            /Malformed combined hunk line prefix/],
        ['a blank unprefixed row', 'diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@\n\n',
            /Malformed combined hunk line prefix/],
        ['inconsistent parent counts', 'diff --cc x\nindex 1111111,2222222,3333333..4444444\n'
            + '@@@ -1,1 -1,1 +1,1 @@@\n  s\n', /Inconsistent merge parent/],
        ['a bare combined header', 'diff --cc x\n', /declares no parent information/],
        ['file headers without hunks', 'diff --cc x\nindex 1111111,2222222..3333333\n--- a/x\n+++ b/x\n',
            /no hunks/],
        ['an index with no changes', 'diff --cc x\nindex 1111111,2222222..3333333\n', /no changes/],
        ['an ordinary single-parent index', 'diff --cc x\nindex 1111111..2222222 100644\n',
            /non-combined extended header/],
        ['metadata after content', 'diff --cc x\n@@@ -1,1 -1,1 +1,1 @@@\n  s\n'
            + 'index 1111111,2222222..3333333\n', /after file content/],
        ['result lines in a deletion', 'diff --cc x\ndeleted file mode 100644,100644\n'
            + '@@@ -1,1 -1,1 +1,1 @@@\n--a\n++b\n', /absent side/],
        ['parent lines in an addition', 'diff --cc x\nnew file mode 100644\n'
            + 'index 0000000,0000000..1111111\n@@@ -1,1 -1,0 +1,1 @@@\n- a\n++b\n', /absent side/],
        ['overlapping result ranges', 'diff --cc x\nindex 1111111,2222222..3333333\n'
            + '@@@ -1,1 -1,1 +2,1 @@@\n  a\n@@@ -9,1 -9,1 +2,1 @@@\n  b\n', /overlap/],
        ['an empty hunk', 'diff --cc x\n@@@ -1,0 -1,0 +1,0 @@@\n', /at least one line/],
        ['both sides /dev/null', 'diff --cc x\n--- /dev/null\n--- /dev/null\n+++ /dev/null\n',
            /Both file sides/],
        ['a missing +++ header', 'diff --cc x\n--- a/x\n@@@ -1,1 -1,1 +1,1 @@@\n  s\n',
            /followed by a \+\+\+ header/],
        ['trailing junk after a hunk', `${MODIFIED}unexpected trailer\n`, /Unexpected combined patch content/],
    ];
    for (const [name, text, message] of malformed) {
        test(`rejects ${name} explicitly`, () => {
            assert.throws(() => parseCombinedParts(Buffer.from(text)), (error: unknown) =>
                error instanceof PatchParseError && message.test(error.message), name);
        });
    }

    test('rejects inputs with no combined diffs instead of returning empty success', () => {
        for (const text of ['', 'Ordinary notes.\n', mail('[PATCH 0/1] Cover', 'Introduction.\n')]) {
            assert.throws(() => parseCombinedParts(Buffer.from(text)), /no combined file diffs/);
        }
    });

    test('honors byte limits, content limits, and cancellation', () => {
        const input = Buffer.from(MODIFIED);
        assert.equal(parseCombinedParts(input, { maxPatchBytes: input.length }).length, 1);
        assert.throws(() => parseCombinedParts(input, { maxPatchBytes: input.length - 1 }),
            OperationLimitError);
        const size = parseCombinedParts(input)[0].files[0].perParent.reduce(
            (total, file) => total + (file.before?.length ?? 0) + (file.after?.length ?? 0), 0);
        assert.equal(parseCombinedParts(input, { maxContentBytes: size }).length, 1);
        assert.throws(() => parseCombinedParts(input, { maxContentBytes: size - 1 }), OperationLimitError);
        const controller = new AbortController();
        controller.abort();
        assert.throws(() => parseCombinedParts(input, { signal: controller.signal }),
            OperationCancelledError);
    });

    test('rejects non-text bytes the same way as the ordinary parser', () => {
        assert.throws(() => parseCombinedParts(Buffer.from([0xff, 0xfe, 0x00])), /not valid UTF-8/);
    });
});
