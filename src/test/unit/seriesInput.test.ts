import * as assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Git } from '../../git';
import { OperationCancelledError, OperationLimitError } from '../../operations';
import { applyPatch } from '../../patch';
import { splitPatchMessages } from '../../patchText';
import { assembleSeries } from '../../seriesInput';
import { commitAll, formatPatch, git, makeRepo, removeTempDirs, writeFiles } from '../helpers';

after(removeTempDirs);

const first = Buffer.from('--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-zero\n+one\n');
const second = Buffer.from('--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-one\n+two\n');

test('assembles numbered plain patches in order without inventing a commit or complete-file context', async () => {
    const series = assembleSeries([
        { name: '0002-second.diff', bytes: second }, { name: '0001-first.diff', bytes: first },
    ]);
    const messages = splitPatchMessages(series);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].metadata.commit, undefined);
    assert.strictEqual(messages[0].metadata.subject, '0001-first.diff');
    const repo = makeRepo({ 'value.txt': 'zero\n' });
    const result = await applyPatch(new Git(), repo, 'HEAD', series);
    assert.strictEqual(result.parts?.length, 2);
    assert.strictEqual(result.changes[0].before?.toString(), 'zero\n');
    assert.strictEqual(result.changes[0].after?.toString(), 'two\n');
    assert.strictEqual(git(repo, 'show', 'HEAD:value.txt'), 'zero\n');
});

test('preserves actual mailbox commits and subjects when separate format-patch files are combined', async () => {
    const repo = makeRepo({ 'value.txt': 'zero\n' });
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    writeFiles(repo, { 'value.txt': 'one\n' });
    const firstCommit = commitAll(repo, 'First change');
    writeFiles(repo, { 'value.txt': 'two\n' });
    const secondCommit = commitAll(repo, 'Second change');
    const series = assembleSeries([
        { name: '0002-second.patch', bytes: Buffer.from(formatPatch(repo, secondCommit)) },
        { name: '0001-first.patch', bytes: Buffer.from(formatPatch(repo, firstCommit)) },
    ]);
    assert.deepStrictEqual(splitPatchMessages(series).map(message => message.metadata.commit),
        [firstCommit, secondCommit]);
    const result = await applyPatch(new Git(), repo, base, series);
    assert.strictEqual(result.changes[0].after?.toString(), 'two\n');
});

test('preserves selection order when patches have no numbering', () => {
    const series = assembleSeries([{ name: 'first.diff', bytes: first }, { name: 'second.diff', bytes: second }]);
    assert.deepStrictEqual(splitPatchMessages(series).map(message => message.metadata.subject),
        ['first.diff', 'second.diff']);
});

test('rejects duplicate numbers rather than choosing an ambiguous order', () => {
    assert.throws(() => assembleSeries([
        { name: '0001-a.diff', bytes: first }, { name: '0001-b.diff', bytes: second },
    ]), /More than one selected file is numbered 1/);
});

test('requires multiple files and validates its operation limits', () => {
    assert.throws(() => assembleSeries([{ name: 'one.diff', bytes: first }]), /at least two/);
    assert.throws(() => assembleSeries([
        { name: 'one.diff', bytes: first }, { name: 'two.diff', bytes: second },
    ], { maxPatchBytes: 0 }), /positive whole number/);
});

test('enforces the exact assembled size, including envelope overhead', () => {
    const inputs = [{ name: 'one.diff', bytes: first }, { name: 'two.diff', bytes: second }];
    const bytes = assembleSeries(inputs).length;
    assert.strictEqual(assembleSeries(inputs, { maxPatchBytes: bytes }).length, bytes);
    assert.throws(() => assembleSeries(inputs, { maxPatchBytes: bytes - 1 }), OperationLimitError);
});

test('cancels before processing any series inputs', () => {
    const aborter = new AbortController();
    aborter.abort();
    assert.throws(() => assembleSeries([
        { name: 'one.diff', bytes: first }, { name: 'two.diff', bytes: second },
    ], { signal: aborter.signal }), OperationCancelledError);
});
