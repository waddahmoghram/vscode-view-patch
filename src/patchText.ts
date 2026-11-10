import { isUtf8 } from 'node:buffer';
import { TextDecoder } from 'node:util';
import {
    DEFAULT_MAX_CONTENT_BYTES,
    DEFAULT_MAX_PATCH_BYTES,
    OperationLimitError,
    OperationOptions,
    positiveLimit,
    throwIfAborted,
} from './operations';

export interface PatchMetadata {
    readonly commit?: string;
    readonly subject?: string;
    readonly author?: string;
    readonly date?: string;
    readonly index?: number;
    readonly total?: number;
}

export interface PatchMessage {
    readonly bytes: Buffer;
    readonly metadata: PatchMetadata;
    readonly hasDiff: boolean;
}

export interface HunkFile {
    readonly status: 'A' | 'C' | 'D' | 'M' | 'R' | 'T';
    readonly oldPath: string;
    readonly newPath: string;
    readonly before?: Buffer;
    readonly after?: Buffer;
    readonly oldMode?: string;
    readonly newMode?: string;
    readonly oldId?: string;
    readonly newId?: string;
    readonly binary?: boolean;
    readonly hasHunks: boolean;
}

export interface HunkPatchPart {
    readonly metadata: PatchMetadata;
    readonly files: readonly HunkFile[];
}

export class PatchParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PatchParseError';
    }
}

interface ByteLine {
    readonly start: number;
    readonly end: number;
    readonly next: number;
}

interface MailHeaders {
    readonly metadata: PatchMetadata;
    readonly complete: boolean;
}

interface HeaderValue {
    readonly start: number;
    end: number;
}

type Check = () => void;
const noop: Check = () => {};
const ENVELOPE = new RegExp(
    '^From ([0-9a-fA-F]{7,64}) (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) '
    + '[A-Z][a-z]{2} {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4}$',
);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;
const NO_NEWLINE = '\\ No newline at end of file';
const BASE85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const PATH_ESCAPES: Readonly<Record<string, number>> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34,
};

function byteLine(bytes: Buffer, start: number): ByteLine {
    const lf = bytes.indexOf(0x0a, start);
    const next = lf < 0 ? bytes.length : lf + 1;
    const end = lf < 0 ? next : lf > start && bytes[lf - 1] === 0x0d ? lf - 1 : lf;
    return { start, end, next };
}

function byteStarts(bytes: Buffer, line: ByteLine, prefix: string): boolean {
    if (line.end - line.start < prefix.length) {
        return false;
    }
    for (let i = 0; i < prefix.length; i++) {
        if (bytes[line.start + i] !== prefix.charCodeAt(i)) {
            return false;
        }
    }
    return true;
}

function envelopeCommit(bytes: Buffer, line: ByteLine): string | undefined {
    if (line.end - line.start > 160 || !byteStarts(bytes, line, 'From ')) {
        return undefined;
    }
    const text = bytes.toString('latin1', line.start, line.end);
    return ENVELOPE.exec(text)?.[1];
}

function revisionCommit(commit?: string): string | undefined {
    return commit && !/^0+$/.test(commit) ? commit : undefined;
}

function decodeWord(word: string, charset: string, encoding: string, value: string): string {
    let bytes: Buffer;
    if (encoding.toLowerCase() === 'b') {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
            return word;
        }
        bytes = Buffer.from(value, 'base64');
    } else {
        const values = Buffer.allocUnsafe(value.length);
        let length = 0;
        for (let i = 0; i < value.length; i++) {
            if (value[i] === '=') {
                if (!/^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
                    return word;
                }
                values[length++] = Number.parseInt(value.slice(i + 1, i + 3), 16);
                i += 2;
            } else if (value.charCodeAt(i) > 0x7f) {
                return word;
            } else {
                values[length++] = value[i] === '_' ? 0x20 : value.charCodeAt(i);
            }
        }
        bytes = values.subarray(0, length);
    }
    try {
        return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
        return word;
    }
}

function decodeHeader(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const bytes = Buffer.from(value, 'latin1');
    if (!isUtf8(bytes)) {
        return undefined;
    }
    const text = bytes.toString('utf8').replace(/(\?=)[ \t]+(?==\?)/g, '$1');
    return text.replace(
        /=\?([A-Za-z0-9._-]+)\?([bBqQ])\?([^?\r\n]*)\?=/g,
        (word: string, charset: string, encoding: string, encoded: string) =>
            decodeWord(word, charset, encoding, encoded),
    );
}

function subjectNumbers(subject?: string): Pick<PatchMetadata, 'index' | 'total'> {
    const prefix = subject?.match(/^\[[^\]]*\bPATCH\b[^\]]*\]/i)?.[0];
    const match = prefix?.match(/\b(\d+)\/(\d+)\b/);
    if (!match) {
        return {};
    }
    const index = Number(match[1]);
    const total = Number(match[2]);
    return Number.isSafeInteger(index) && Number.isSafeInteger(total) && total > 0 && index <= total
        ? { index, total } : {};
}

function mailHeaders(bytes: Buffer, start: number, check: Check): MailHeaders {
    const values = new Map<string, HeaderValue>();
    const value = (name: string) => {
        const field = values.get(name);
        return field
            ? bytes.toString('latin1', field.start, field.end).replace(/\r?\n[ \t]+/g, ' ').trim()
            : undefined;
    };
    let key: string | undefined;
    for (let offset = start; offset < bytes.length;) {
        check();
        const line = byteLine(bytes, offset);
        offset = line.next;
        const text = bytes.toString('latin1', line.start, line.end);
        if (text === '') {
            const subject = decodeHeader(value('subject'));
            const author = decodeHeader(value('from'));
            const date = decodeHeader(value('date'));
            return {
                metadata: { subject, author, date, ...subjectNumbers(subject) },
                complete: values.has('subject'),
            };
        }
        if (/^[ \t]/.test(text) && key) {
            const field = values.get(key);
            if (field) {
                field.end = line.end;
            }
            continue;
        }
        const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(text);
        if (!match) {
            break;
        }
        key = match[1].toLowerCase();
        if (['from', 'date', 'subject'].includes(key) && !values.has(key)) {
            values.set(key, { start: line.end - match[2].length, end: line.end });
        } else {
            key = undefined;
        }
    }
    return { metadata: {}, complete: false };
}

function plainMetadata(bytes: Buffer, first: ByteLine, check: Check): PatchMetadata {
    const firstText = bytes.toString('latin1', first.start, first.end);
    const commit = revisionCommit(/^(?:commit|From) ([0-9a-fA-F]{7,64})(?:\s|$)/.exec(firstText)?.[1]);
    if (!firstText.startsWith('commit ')) {
        return { ...mailHeaders(bytes, first.start, check).metadata, ...(commit ? { commit } : {}) };
    }
    let author: string | undefined;
    let date: string | undefined;
    let subject: string | undefined;
    for (let offset = first.next; offset < bytes.length;) {
        check();
        const line = byteLine(bytes, offset);
        offset = line.next;
        if (byteStarts(bytes, line, 'diff ')) {
            break;
        }
        const text = decodeHeader(bytes.toString('latin1', line.start, line.end));
        if (text?.startsWith('Author:')) {
            author = text.slice(7).trim();
        } else if (text?.startsWith('Date:')) {
            date = text.slice(5).trim();
        } else if (text?.startsWith('    ') && text.trim()) {
            subject = text.trim();
            break;
        }
    }
    return { commit, author, date, subject };
}

function isDiffLine(bytes: Buffer, line: ByteLine): boolean {
    if (byteStarts(bytes, line, 'diff --git ')
        || byteStarts(bytes, line, 'diff --cc ')
        || byteStarts(bytes, line, 'diff --combined ')) {
        return true;
    }
    return byteStarts(bytes, line, '--- ') && line.next < bytes.length
        && byteStarts(bytes, byteLine(bytes, line.next), '+++ ');
}

/**
 * Splits mail envelopes without changing bytes, including signatures and cover letters.
 * Returned buffers share input storage; non-text bytes are intentionally accepted here.
 */
export function splitPatchMessages(bytes: Uint8Array): readonly PatchMessage[] {
    return splitMessages(bytes, noop);
}

function splitMessages(bytes: Uint8Array, check: Check): readonly PatchMessage[] {
    const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (raw.length === 0) {
        return [];
    }
    let first = byteLine(raw, raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0);
    while (first.end === first.start && first.next < raw.length) {
        check();
        first = byteLine(raw, first.next);
    }
    const commit = envelopeCommit(raw, first);
    const headers = commit ? mailHeaders(raw, first.next, check) : undefined;
    const mailbox = headers?.complete === true;
    let metadata: PatchMetadata = mailbox
        ? { commit: revisionCommit(commit), ...headers.metadata } : plainMetadata(raw, first, check);
    let start = 0;
    let hasDiff = false;
    const messages: PatchMessage[] = [];
    for (let offset = first.start; offset < raw.length;) {
        check();
        const line = byteLine(raw, offset);
        offset = line.next;
        if (mailbox && line.start !== first.start) {
            const nextCommit = envelopeCommit(raw, line);
            const nextHeaders = nextCommit ? mailHeaders(raw, line.next, check) : undefined;
            if (nextHeaders?.complete) {
                messages.push({ bytes: raw.subarray(start, line.start), metadata, hasDiff });
                start = line.start;
                metadata = { commit: revisionCommit(nextCommit), ...nextHeaders.metadata };
                hasDiff = false;
            }
        }
        hasDiff ||= isDiffLine(raw, line);
    }
    messages.push({ bytes: raw.subarray(start), metadata, hasDiff });
    return messages;
}

interface TextLine {
    readonly text: string;
    readonly ending: string;
    readonly number: number;
    readonly next: number;
}

class Lines {
    private offset = 0;
    private number = 1;
    private cached?: TextLine;

    constructor(private readonly text: string) {}

    peek(): TextLine | undefined {
        if (this.offset >= this.text.length) {
            return undefined;
        }
        if (!this.cached) {
            const lf = this.text.indexOf('\n', this.offset);
            const next = lf < 0 ? this.text.length : lf + 1;
            const cr = lf > this.offset && this.text[lf - 1] === '\r';
            const end = lf < 0 ? next : cr ? lf - 1 : lf;
            this.cached = {
                text: this.text.slice(this.offset, end),
                ending: lf < 0 ? '' : cr ? '\r\n' : '\n',
                number: this.number,
                next,
            };
        }
        return this.cached;
    }

    take(): TextLine | undefined {
        const line = this.peek();
        if (line) {
            this.offset = line.next;
            this.number++;
            this.cached = undefined;
        }
        return line;
    }
}

function fail(message: string, line?: TextLine): never {
    throw new PatchParseError(`${message}${line ? ` (patch line ${line.number})` : ''}.`);
}

function validPath(value: string): string {
    if (value === '' || value.includes('\0')) {
        fail('A file path is empty or contains a NUL byte');
    }
    return value;
}

function quotedPath(text: string, check: Check): { path: string; next: number } {
    const output = Buffer.allocUnsafe(Buffer.byteLength(text));
    let length = 0;
    let start = 1;
    let nextCheck = 4096;
    for (let i = 1; i < text.length; i++) {
        if (i >= nextCheck) {
            check();
            nextCheck = i + 4096;
        }
        if (text[i] !== '\\' && text[i] !== '"') {
            continue;
        }
        length += output.write(text.slice(start, i), length, 'utf8');
        if (text[i] === '"') {
            const bytes = output.subarray(0, length);
            if (!isUtf8(bytes)) {
                fail('A quoted file path is not valid UTF-8');
            }
            return { path: validPath(bytes.toString('utf8')), next: i + 1 };
        }
        const escaped = text[++i];
        if (escaped !== undefined && escaped in PATH_ESCAPES) {
            output[length++] = PATH_ESCAPES[escaped];
        } else if (escaped !== undefined && /^[0-7]$/.test(escaped)) {
            let value = escaped.charCodeAt(0) - 48;
            let digits = 1;
            while (digits < 3 && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 55) {
                value = value * 8 + text.charCodeAt(++i) - 48;
                digits++;
            }
            if (value > 255) {
                fail('An octal file path escape exceeds one byte');
            }
            output[length++] = value;
        } else {
            fail('Invalid C-style escape in a quoted file path');
        }
        start = i + 1;
    }
    return fail('Unterminated quoted file path');
}

function headerPath(text: string, check: Check): string {
    if (text.startsWith('"')) {
        const parsed = quotedPath(text, check);
        if (text.slice(parsed.next) !== '' && !text.slice(parsed.next).startsWith('\t')) {
            fail('Unexpected text after a quoted file path');
        }
        return parsed.path;
    }
    return validPath(text.split('\t', 1)[0]);
}

function gitPaths(text: string, check: Check): readonly [string, string] {
    if (text.startsWith('"')) {
        const old = quotedPath(text, check);
        if (text[old.next] !== ' ') {
            fail('Missing second path in a diff --git header');
        }
        return [old.path, headerPath(text.slice(old.next + 1), check)];
    }
    const quoted = text.indexOf(' "');
    if (quoted >= 0) {
        return [validPath(text.slice(0, quoted)), headerPath(text.slice(quoted + 1), check)];
    }
    const middle = (text.length - 1) / 2;
    if (Number.isInteger(middle) && text[middle] === ' ') {
        const old = text.slice(0, middle);
        const next = text.slice(middle + 1);
        if (old === next || old.startsWith('a/') && next === `b/${old.slice(2)}`) {
            return [validPath(old), validPath(next)];
        }
    }
    const boundary = text.indexOf(' b/');
    const space = boundary >= 0 ? boundary : text.indexOf(' ');
    if (space <= 0 || space === text.length - 1) {
        fail('Missing file paths in a diff --git header');
    }
    return [validPath(text.slice(0, space)), validPath(text.slice(space + 1))];
}

class ContentBudget {
    private used = 0;

    constructor(private readonly maximum: number, readonly check: Check) {}

    add(text: string): void {
        this.check();
        const size = Buffer.byteLength(text);
        if (size > this.maximum - this.used) {
            throw new OperationLimitError(`Partial-context content exceeds ${this.maximum} bytes.`);
        }
        this.used += size;
    }
}

class Side {
    private readonly chunks: Buffer[] = [];
    private pending = '';
    private hunks = 0;

    constructor(private readonly label: 'Original' | 'New', private readonly budget: ContentBudget) {
        this.append(`[Partial context only - ${label.toLowerCase()} side; not a complete file]\n`);
    }

    append(text: string): void {
        if (text !== '') {
            this.budget.add(text);
            this.pending += text;
            if (this.pending.length >= 16 * 1024) {
                this.flush();
            }
        }
    }

    private flush(): void {
        if (this.pending !== '') {
            this.chunks.push(Buffer.from(this.pending));
            this.pending = '';
        }
    }

    hunk(start: number, count: number): void {
        if (this.hunks++ > 0) {
            this.append('[... omitted context between hunks (if any) ...]\n');
        }
        const range = count === 0 ? `none (anchor ${start})` : `${start}-${start + count - 1}`;
        this.append(`[${this.label} lines ${range}]\n`);
    }

    unavailable(binary: boolean): void {
        const reason = binary ? 'binary payload is not reconstructed' : 'no text hunks supplied';
        this.append(`[${this.label} line ranges unavailable: ${reason}.]\n`);
    }

    bytes(): Buffer {
        this.flush();
        return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    }
}

interface Range {
    readonly start: number;
    readonly count: number;
}

function range(start: string, count: string | undefined, line: TextLine): Range {
    const result = { start: Number(start), count: count === undefined ? 1 : Number(count) };
    if (!Number.isSafeInteger(result.start) || !Number.isSafeInteger(result.count)
        || result.count > 0 && result.start === 0
        || !Number.isSafeInteger(result.start + (result.count || 1))) {
        fail('Invalid or excessively large hunk line range', line);
    }
    return result;
}

class FileBuilder {
    oldMode?: string;
    newMode?: string;
    oldId?: string;
    newId?: string;
    binary = false;
    hasHunks = false;
    textHeaders = false;
    private added = false;
    private deleted = false;
    private oldModeHeader = false;
    private newModeHeader = false;
    private from?: string;
    private to?: string;
    private movement?: 'R' | 'C';
    private before?: Side;
    private after?: Side;
    private oldEnd = 0;
    private newEnd = 0;
    private oldEof = false;
    private newEof = false;
    private readonly prefixed: boolean;

    constructor(
        public oldPath: string,
        public newPath: string,
        private readonly git: boolean,
        private readonly budget: ContentBudget,
    ) {
        this.prefixed = git && oldPath.startsWith('a/') && newPath.startsWith('b/');
        this.oldPath = this.strip(oldPath, 'a/');
        this.newPath = this.strip(newPath, 'b/');
    }

    private strip(path: string, prefix: string): string {
        return this.prefixed && path.startsWith(prefix) ? path.slice(2) : path;
    }

    paths(old: string, next: string, line: TextLine): void {
        if (old === '/dev/null' && next === '/dev/null') {
            fail('Both file sides are /dev/null', line);
        }
        this.added ||= old === '/dev/null';
        this.deleted ||= next === '/dev/null';
        const prefixed = this.git ? this.prefixed : old.startsWith('a/') && next.startsWith('b/')
            || old === '/dev/null' && next.startsWith('b/') || next === '/dev/null' && old.startsWith('a/');
        this.oldPath = old === '/dev/null' ? next : old;
        this.newPath = next === '/dev/null' ? old : next;
        if (prefixed) {
            this.oldPath = this.oldPath.replace(old === '/dev/null' ? /^b\// : /^a\//, '');
            this.newPath = this.newPath.replace(next === '/dev/null' ? /^a\// : /^b\//, '');
        }
        this.textHeaders = true;
    }

    metadata(text: string, line: TextLine): boolean {
        const mode = /^(old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/.exec(text);
        const index = /^index ([0-9a-fA-F]{1,64})\.\.([0-9a-fA-F]{1,64})(?: ([0-7]{6}))?$/.exec(text);
        const move = /^(rename|copy) (from|to) (.+)$/.exec(text);
        const similarity = /^(?:dis)?similarity index (\d{1,3})%$/.exec(text);
        if (!mode && !index && !move && !similarity) {
            if (/^(?:old mode|new mode|new file mode|deleted file mode|index |rename |copy |similarity |dissimilarity )/
                .test(text)) {
                fail('Malformed extended diff header', line);
            }
            return false;
        }
        if (this.hasHunks || this.binary || this.textHeaders) {
            fail('Extended diff header occurs after file content', line);
        }
        if (mode) {
            switch (mode[1]) {
                case 'old mode': this.oldMode = mode[2]; this.oldModeHeader = true; break;
                case 'new mode': this.newMode = mode[2]; this.newModeHeader = true; break;
                case 'new file mode':
                    this.added = true;
                    this.oldMode = '000000';
                    this.newMode = mode[2];
                    break;
                case 'deleted file mode':
                    this.deleted = true;
                    this.oldMode = mode[2];
                    this.newMode = '000000';
                    break;
            }
        } else if (index) {
            this.oldId = index[1];
            this.newId = index[2];
            this.oldMode ??= index[3];
            this.newMode ??= index[3];
        } else if (move) {
            const movement = move[1] === 'rename' ? 'R' : 'C';
            if (this.movement && this.movement !== movement) {
                fail('A file cannot be both renamed and copied', line);
            }
            this.movement = movement;
            const path = headerPath(move[3], this.budget.check);
            if (move[2] === 'from') {
                this.from = path;
            } else {
                this.to = path;
            }
        } else if (similarity && Number(similarity[1]) > 100) {
            fail('Similarity percentage exceeds 100', line);
        }
        return true;
    }

    private status(): HunkFile['status'] {
        if (this.added) {
            return 'A';
        }
        if (this.deleted) {
            return 'D';
        }
        if (this.movement) {
            return this.movement;
        }
        return this.oldMode && this.newMode && this.oldMode.slice(0, 3) !== this.newMode.slice(0, 3) ? 'T' : 'M';
    }

    private sides(): void {
        const status = this.status();
        if (status !== 'A' && !this.before) {
            this.before = new Side('Original', this.budget);
        }
        if (status !== 'D' && !this.after) {
            this.after = new Side('New', this.budget);
        }
    }

    hunk(lines: Lines): void {
        const header = lines.take();
        if (!header) {
            return;
        }
        const match = HUNK.exec(header.text);
        if (!match || !this.textHeaders || this.binary) {
            fail('Malformed hunk header or missing --- / +++ file headers', header);
        }
        const old = range(match[1], match[2], header);
        const next = range(match[3], match[4], header);
        if (old.count === 0 && next.count === 0) {
            fail('A hunk must contain at least one line', header);
        }
        if (this.added && old.count !== 0 || this.deleted && next.count !== 0) {
            fail('An added or deleted file has lines on its absent side', header);
        }
        const oldPosition = old.start + (old.count === 0 ? 1 : 0);
        const newPosition = next.start + (next.count === 0 ? 1 : 0);
        if (oldPosition < this.oldEnd || newPosition < this.newEnd || this.oldEof || this.newEof) {
            fail('Hunk ranges overlap, are out of order, or continue past a no-newline marker', header);
        }
        this.oldEnd = oldPosition + old.count;
        this.newEnd = newPosition + next.count;
        this.sides();
        this.before?.hunk(old.start, old.count);
        this.after?.hunk(next.start, next.count);
        let oldLeft = old.count;
        let newLeft = next.count;
        let pending: { kind: string; text: string; ending: string; marked: boolean } | undefined;
        const flush = () => {
            if (pending) {
                if (pending.kind !== '+') {
                    this.before?.append(pending.text);
                    this.before?.append(pending.ending);
                }
                if (pending.kind !== '-') {
                    this.after?.append(pending.text);
                    this.after?.append(pending.ending);
                }
            }
        };
        while (oldLeft > 0 || newLeft > 0 || lines.peek()?.text === NO_NEWLINE) {
            this.budget.check();
            const line = lines.take();
            if (!line) {
                fail(`Truncated hunk: ${oldLeft} original and ${newLeft} new lines are missing`, header);
            }
            if (line.text === NO_NEWLINE) {
                if (!pending || pending.marked
                    || pending.kind !== '+' && oldLeft !== 0 || pending.kind !== '-' && newLeft !== 0) {
                    fail('Misplaced no-newline marker', line);
                }
                pending.ending = '';
                pending.marked = true;
                this.oldEof ||= pending.kind !== '+';
                this.newEof ||= pending.kind !== '-';
                continue;
            }
            const kind = line.text[0];
            if (kind !== ' ' && kind !== '-' && kind !== '+') {
                fail(`Truncated hunk: expected ${oldLeft} original and ${newLeft} new lines`, line);
            }
            if (kind !== '+' && --oldLeft < 0 || kind !== '-' && --newLeft < 0) {
                fail('Hunk content exceeds the declared line counts', line);
            }
            flush();
            pending = { kind, text: line.text.slice(1), ending: line.ending, marked: false };
        }
        flush();
        this.hasHunks = true;
    }

    finish(): HunkFile {
        if (this.added && this.deleted || this.movement && (this.added || this.deleted)) {
            fail('Contradictory added, deleted, or moved file metadata');
        }
        if (this.oldModeHeader !== this.newModeHeader || this.movement && (!this.from || !this.to)) {
            fail('Incomplete mode, rename, or copy metadata');
        }
        if (this.textHeaders && !this.hasHunks && !this.binary) {
            fail('File headers have no hunks; the patch may be truncated');
        }
        if (!this.hasHunks && !this.binary && !this.added && !this.deleted
            && !this.movement && !this.oldModeHeader) {
            fail('A diff header has no changes; the patch may be truncated');
        }
        if (!this.hasHunks) {
            this.sides();
            this.before?.unavailable(this.binary);
            this.after?.unavailable(this.binary);
        }
        return {
            status: this.status(),
            oldPath: validPath(this.from ?? this.oldPath),
            newPath: validPath(this.to ?? this.newPath),
            before: this.before?.bytes(),
            after: this.after?.bytes(),
            oldMode: this.oldMode,
            newMode: this.newMode,
            oldId: this.oldId,
            newId: this.newId,
            binary: this.binary || undefined,
            hasHunks: this.hasHunks,
        };
    }
}

function binaryPayload(lines: Lines, check: Check): void {
    lines.take();
    let blocks = 0;
    while (lines.peek()?.text.match(/^(?:literal|delta) /)) {
        check();
        const header = lines.take();
        const match = /^(?:literal|delta) (\d+)$/.exec(header?.text ?? '');
        if (!match || !Number.isSafeInteger(Number(match[1])) || ++blocks > 2) {
            fail('Malformed Git binary patch block header', header);
        }
        let rows = 0;
        for (let line = lines.peek(); line && line.text !== ''; line = lines.peek()) {
            check();
            const code = line.text.charCodeAt(0);
            const count = code >= 65 && code <= 90 ? code - 64 : code >= 97 && code <= 122 ? code - 70 : 0;
            if (count === 0 || line.text.length !== 1 + Math.ceil(count / 4) * 5
                || [...line.text.slice(1)].some(char => !BASE85.includes(char))) {
                fail('Malformed or truncated Git binary patch payload', line);
            }
            rows++;
            lines.take();
        }
        if (rows === 0) {
            fail('Git binary patch block has no payload', header);
        }
        if (lines.peek()?.text === '') {
            lines.take();
        }
    }
    if (blocks === 0) {
        fail('Git binary patch has no literal or delta block', lines.peek());
    }
}

function parseMessage(message: PatchMessage, budget: ContentBudget): HunkPatchPart {
    const lines = new Lines(message.bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const files: HunkFile[] = [];
    let file: FileBuilder | undefined;
    const finish = () => {
        if (file) {
            files.push(file.finish());
            file = undefined;
        }
    };
    for (let line = lines.peek(); line; line = lines.peek()) {
        budget.check();
        const text = line.text;
        if (/^diff --(?:cc|combined)(?: |$)/.test(text) || text.startsWith('@@@')) {
            fail('Combined merge diffs are unsupported; use a two-sided diff', line);
        }
        if (/^diff --git(?: |$)/.test(text)) {
            finish();
            const [old, next] = gitPaths(text.slice(11), budget.check);
            file = new FileBuilder(old, next, true, budget);
            lines.take();
        } else if (text.startsWith('--- ')) {
            if (file?.textHeaders || file?.hasHunks || file?.binary) {
                finish();
            }
            lines.take();
            const next = lines.take();
            if (!next?.text.startsWith('+++ ')) {
                fail('A --- file header must be followed by a +++ header', line);
            }
            file ??= new FileBuilder('', '', false, budget);
            file.paths(headerPath(text.slice(4), budget.check), headerPath(next.text.slice(4), budget.check), line);
        } else if (text.startsWith('@@')) {
            if (!file) {
                fail('A hunk has no file headers', line);
            }
            file.hunk(lines);
        } else if (file && text === 'GIT binary patch') {
            if (file.hasHunks || file.binary) {
                fail('A file mixes binary and text patch content', line);
            }
            binaryPayload(lines, budget.check);
            file.binary = true;
        } else if (file && /^Binary files .+ differ$/.test(text)) {
            if (file.hasHunks || file.binary) {
                fail('A file mixes binary and text patch content', line);
            }
            file.binary = true;
            lines.take();
        } else if (file?.metadata(text, line)) {
            lines.take();
        } else if (text === '-- ') {
            finish();
            break;
        } else if (/^(?:diff |Index: |={3,}$)/.test(text)) {
            finish();
            lines.take();
        } else if (text === '') {
            lines.take();
        } else if (file || text.startsWith('+++ ') || text === NO_NEWLINE) {
            fail(`Unexpected patch content: ${text.slice(0, 80)}`, line);
        } else {
            lines.take();
        }
    }
    finish();
    return { metadata: message.metadata, files };
}

/** Materializes only supplied hunk lines, with synthetic partial-context labels, never a reconstructed file. */
export function parseHunks(bytes: Uint8Array, options: OperationOptions = {}): readonly HunkPatchPart[] {
    const check = () => throwIfAborted(options.signal);
    check();
    const maximum = positiveLimit('maxPatchBytes', options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);
    const contentMaximum = positiveLimit('maxContentBytes', options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES);
    if (bytes.byteLength > maximum) {
        throw new OperationLimitError(`Patch exceeds ${maximum} bytes.`);
    }
    if (!isUtf8(bytes)) {
        fail('The patch is not valid UTF-8; use the repository-backed viewer for non-text bytes');
    }
    const budget = new ContentBudget(contentMaximum, check);
    const parts = splitMessages(bytes, check).map(message => parseMessage(message, budget));
    if (!parts.some(part => part.files.length > 0)) {
        fail('The input contains no supported file diffs');
    }
    check();
    return parts;
}
