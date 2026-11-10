import * as assert from 'assert';
import * as vscode from 'vscode';
import { contentFingerprint, PatchDocuments, renderContent, SnapshotFile } from '../../documents';
import { OperationLimitError } from '../../operations';
import { preserveReviewed, Review, ReviewData, reviewFileKey, ReviewTree } from '../../reviews';

suite('Review snapshots', () => {
    function file(before = 'before\n', after = 'after\n', name = 'example.txt'): SnapshotFile {
        return { status: 'M', oldPath: name, newPath: name, before: Buffer.from(before), after: Buffer.from(after) };
    }

    test('distinguishes binary files of equal size by content fingerprint', () => {
        const before = Buffer.from([0, 1, 2]);
        const after = Buffer.from([0, 1, 3]);
        assert.notStrictEqual(renderContent(before), renderContent(after));
        assert.match(renderContent(before), new RegExp(contentFingerprint(before)));
        assert.match(renderContent(after), /3 bytes/);
        assert.match(renderContent(after), /does not display the file bytes/);
    });

    test('decodes supported byte-order marks without replacement characters', () => {
        const text = 'naïve\n';
        const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
        const big = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
        assert.strictEqual(renderContent(little), `Encoding: utf-16le (byte-order mark)\n\n${text}`);
        assert.strictEqual(renderContent(big), `Encoding: utf-16be (byte-order mark)\n\n${text}`);
        assert.strictEqual(renderContent(Buffer.from(text)), text);
        const invalid = renderContent(Buffer.from([0xc3, 0x28]));
        assert.match(invalid, /undecodable/);
        assert.ok(!invalid.includes('\ufffd'));
    });

    test('rejects truncated marked text instead of silently substituting bytes', () => {
        assert.match(renderContent(Buffer.from([0xff, 0xfe, 0x41])), /undecodable/);
    });

    test('creates an empty side for added or deleted files with an absolute label path', () => {
        const documents = new PatchDocuments();
        try {
            const uri = documents.emptyUri('review', '/repository/new.txt');
            assert.strictEqual(uri.path, '/repository/new.txt');
            assert.strictEqual(documents.provideTextDocumentContent(uri), '');
        } finally {
            documents.dispose();
        }
    });

    test('serves absolute paths from plain unified patches without an invalid double-slash address', () => {
        const documents = new PatchDocuments();
        try {
            documents.replace('absolute', [{ key: 'combined', files: [file('old', 'new', '/tmp/example.txt')] }]);
            const [label, before, after] = documents.resources('absolute', 'combined')[0];
            assert.strictEqual(label.path, '/tmp/example.txt');
            assert.ok(before && after);
            assert.strictEqual(documents.provideTextDocumentContent(before), 'old');
            assert.strictEqual(documents.provideTextDocumentContent(after), 'new');
        } finally {
            documents.dispose();
        }
    });

    test('keeps content for more than twenty views until explicitly released', () => {
        const documents = new PatchDocuments();
        try {
            for (let index = 0; index < 25; index++) {
                documents.replace(`view${index}`, [{ key: 'combined', files: [file()] }], new Set());
            }
            assert.strictEqual(documents.count, 25);
            const before = documents.resources('view0', 'combined')[0][1];
            assert.ok(before);
            assert.strictEqual(documents.provideTextDocumentContent(before), 'before\n');
            documents.remove('view0');
            assert.strictEqual(documents.count, 24);
            assert.match(documents.provideTextDocumentContent(before), /closed View Patch review/);
        } finally {
            documents.dispose();
        }
    });

    test('accepts the exact memory bound and rejects one byte more without changing old views', () => {
        const documents = new PatchDocuments(6);
        try {
            documents.replace('first', [{ key: 'combined', files: [file('abc', 'def')] }], new Set());
            assert.strictEqual(documents.bytes, 6);
            assert.throws(() => documents.replace('second', [{
                key: 'combined', files: [file('', 'x')],
            }], new Set()), OperationLimitError);
            assert.strictEqual(documents.count, 1);
            assert.strictEqual(documents.bytes, 6);
            const before = documents.resources('first', 'combined')[0][1];
            assert.ok(before);
            assert.strictEqual(documents.provideTextDocumentContent(before), 'abc');
            documents.remove('first');
            assert.strictEqual(documents.bytes, 0);
            documents.replace('second', [{ key: 'combined', files: [file('', 'x')] }], new Set());
            assert.strictEqual(documents.bytes, 1);
        } finally {
            documents.dispose();
        }
    });

    test('shares buffers between cumulative and per-patch sections without double charging', () => {
        const documents = new PatchDocuments(6);
        try {
            const change = file('abc', 'def');
            documents.replace('review', [
                { key: 'combined', files: [change] }, { key: 'part1', files: [change] },
            ], new Set());
            assert.strictEqual(documents.bytes, 6);
        } finally {
            documents.dispose();
        }
    });

    test('retains a removed path while its individual document remains open', () => {
        const documents = new PatchDocuments();
        try {
            documents.replace('review', [{ key: 'combined', files: [file('old', 'new', 'old.txt')] }], new Set());
            const retained = documents.resources('review', 'combined')[0][2];
            assert.ok(retained);
            documents.replace('review', [{ key: 'combined', files: [file('a', 'b', 'other.txt')] }],
                new Set([retained.toString()]));
            assert.strictEqual(documents.provideTextDocumentContent(retained), 'new');
            assert.strictEqual(documents.resources('review', 'combined').length, 1);
        } finally {
            documents.dispose();
        }
    });

    test('publishes changed document events when a view is refreshed', () => {
        const documents = new PatchDocuments();
        const events: string[] = [];
        const listener = documents.onDidChange(uri => events.push(uri.toString()));
        try {
            documents.replace('review', [{ key: 'combined', files: [file('old', 'one')] }], new Set());
            const uri = documents.resources('review', 'combined')[0][2];
            assert.ok(uri);
            events.length = 0;
            documents.replace('review', [{ key: 'combined', files: [file('old', 'two')] }], new Set());
            assert.ok(events.includes(uri.toString()));
            assert.strictEqual(documents.provideTextDocumentContent(uri), 'two');
        } finally {
            listener.dispose();
            documents.dispose();
        }
    });

    test('retains review flags only when the exact change remains unchanged', () => {
        const first = file('old', 'one');
        const data: ReviewData = {
            source: { uri: vscode.Uri.parse('untitled:example.patch'), name: 'example.patch' },
            mode: 'complete',
            digest: 'first',
            sections: [{ key: 'combined', label: 'Changes', files: [first] }],
        };
        const review: Review = {
            ...data, id: 'r1', title: 'Review', section: 'combined', opening: false, seen: true,
            reviewed: new Set([reviewFileKey('combined', first)]),
        };
        assert.strictEqual(preserveReviewed(review, data).size, 1);
        const changed = { ...data, sections: [{ key: 'combined', label: 'Changes', files: [file('old', 'two')] }] };
        assert.strictEqual(preserveReviewed(review, changed).size, 0);
        const tree = new ReviewTree(new Map([['r1', review]]));
        try {
            const root = tree.getChildren()[0];
            const item = tree.getChildren(root).find(node => node.kind === 'file');
            assert.strictEqual(item?.contextValue, 'viewPatch.file.reviewed');
        } finally {
            tree.dispose();
        }
    });
});
