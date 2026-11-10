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
    /** The verbatim message bytes; always a byte-preserving view of the input. */
    readonly bytes: Buffer;
    /**
     * The original headers followed by the transfer-decoded body. Present only when the message
     * headers declare `Content-Transfer-Encoding: quoted-printable` or `base64` and the body
     * decoded cleanly; `7bit`, `8bit`, and `binary` bodies stay in `bytes` alone. Decoding is
     * byte-exact and never reinterprets charsets. Consumers that read message content should
     * prefer `decodedBytes ?? bytes`; `bytes` stays raw so concatenating messages reproduces
     * the input exactly.
     */
    readonly decodedBytes?: Buffer;
    readonly metadata: PatchMetadata;
    readonly hasDiff: boolean;
    /** True when the diff content is a combined merge diff (diff --cc/--combined or @@@ hunks). */
    readonly combined?: boolean;
    /**
     * A complete sentence describing why the body cannot be interpreted: an unsupported
     * Content-Transfer-Encoding (named), a multipart Content-Type, or malformed base64.
     * Splitting itself never throws; parseHunks and parseCombinedParts raise this message
     * as a PatchParseError instead of guessing at undecodable bytes.
     */
    readonly encodingError?: string;
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

export interface CombinedFile {
    /** The merge-result path from the diff --cc/--combined header. */
    readonly path: string;
    readonly parents: number;
    /**
     * Element i is an ordinary HunkFile view of the change versus parent i+1, derived from the
     * documented per-line column semantics. It materializes only lines the combined text carries
     * for that parent and keeps omitted context explicit, exactly like parseHunks output.
     */
    readonly perParent: readonly HunkFile[];
}

export interface CombinedPatchPart {
    readonly metadata: PatchMetadata;
    readonly files: readonly CombinedFile[];
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
    readonly bodyStart: number;
    readonly encoding?: string;
    readonly contentType?: string;
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
const COMBINED_HEADER = /^diff --(?:cc|combined)(?: |$)/;
const COMBINED_HUNK = /^(@{3,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1(?: .*)?$/;
const PASSTHROUGH_ENCODINGS = ['7bit', '8bit', 'binary'];
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
                bodyStart: line.next,
                encoding: value('content-transfer-encoding'),
                contentType: value('content-type'),
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
        if (['from', 'date', 'subject', 'content-transfer-encoding', 'content-type'].includes(key)
            && !values.has(key)) {
            values.set(key, { start: line.end - match[2].length, end: line.end });
        } else {
            key = undefined;
        }
    }
    return { metadata: {}, complete: false, bodyStart: bytes.length };
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

function toBuffer(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function hexDigit(byte: number | undefined): number {
    if (byte === undefined) {
        return -1;
    }
    if (byte >= 0x30 && byte <= 0x39) {
        return byte - 0x30;
    }
    if (byte >= 0x41 && byte <= 0x46) {
        return byte - 0x37;
    }
    return byte >= 0x61 && byte <= 0x66 ? byte - 0x57 : -1;
}

/**
 * RFC 2045 quoted-printable, byte-exact: soft line breaks (`=` plus transport padding before a
 * line break) disappear, `=XX` hex pairs become single bytes, trailing whitespace before a line
 * break is transport padding and is deleted, and invalid `=` sequences stay literal rather than
 * inventing content. Bytes in, bytes out; charsets are never reinterpreted.
 */
function decodeQuotedPrintable(body: Buffer, check: Check): Buffer {
    const output = Buffer.allocUnsafe(body.length);
    let length = 0;
    for (let offset = 0; offset < body.length;) {
        if ((offset & 0xfff) === 0) {
            check();
        }
        const byte = body[offset];
        if (byte === 0x3d) {
            let next = offset + 1;
            while (next < body.length && (body[next] === 0x20 || body[next] === 0x09)) {
                next++;
            }
            if (body[next] === 0x0a) {
                offset = next + 1;
                continue;
            }
            if (body[next] === 0x0d && body[next + 1] === 0x0a) {
                offset = next + 2;
                continue;
            }
            const high = hexDigit(body[offset + 1]);
            const low = hexDigit(body[offset + 2]);
            if (high >= 0 && low >= 0) {
                output[length++] = high * 16 + low;
                offset += 3;
                continue;
            }
            output[length++] = byte;
            offset++;
            continue;
        }
        if (byte === 0x20 || byte === 0x09) {
            let next = offset + 1;
            while (next < body.length && (body[next] === 0x20 || body[next] === 0x09)) {
                next++;
            }
            if (next < body.length && (body[next] === 0x0a || body[next] === 0x0d && body[next + 1] === 0x0a)) {
                offset = next;
                continue;
            }
            while (offset < next) {
                output[length++] = body[offset++];
            }
            continue;
        }
        output[length++] = byte;
        offset++;
    }
    return output.subarray(0, length);
}

/** RFC 2045 base64 with whitespace tolerance; undefined when bytes fall outside the alphabet. */
function decodeBase64(body: Buffer, check: Check): Buffer | undefined {
    let text = '';
    for (let offset = 0; offset < body.length; offset += 4096) {
        check();
        text += body.toString('latin1', offset, Math.min(offset + 4096, body.length))
            .replace(/[ \t\r\n]+/g, '');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
        return undefined;
    }
    return Buffer.from(text, 'base64');
}

function combinedHunkParents(text: string): number {
    const match = COMBINED_HUNK.exec(text);
    if (!match) {
        return 0;
    }
    const parents = match[1].length - 1;
    return match[2].trimEnd().split(' ').length === parents ? parents : 0;
}

interface ContentScan {
    readonly hasDiff: boolean;
    readonly combined: boolean;
}

/** One cheap pass for diff detection plus combined-diff detection outside ordinary hunk bodies. */
function scanContent(bytes: Buffer, check: Check): ContentScan {
    let hasDiff = false;
    let combined = false;
    let oldLeft = 0;
    let newLeft = 0;
    for (let offset = 0; offset < bytes.length;) {
        check();
        const line = byteLine(bytes, offset);
        offset = line.next;
        hasDiff ||= isDiffLine(bytes, line);
        if (combined) {
            continue;
        }
        const first = bytes[line.start];
        if (oldLeft > 0 || newLeft > 0) {
            if (first === 0x20) {
                oldLeft--;
                newLeft--;
                continue;
            }
            if (first === 0x2d) {
                oldLeft--;
                continue;
            }
            if (first === 0x2b) {
                newLeft--;
                continue;
            }
            if (first === 0x5c) {
                continue;
            }
            oldLeft = 0;
            newLeft = 0;
        }
        if (first !== 0x40 && first !== 0x64) {
            continue;
        }
        const text = bytes.toString('latin1', line.start, line.end);
        const hunk = HUNK.exec(text);
        if (hunk) {
            oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
            newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
            continue;
        }
        combined ||= COMBINED_HEADER.test(text) || combinedHunkParents(text) > 0;
    }
    return { hasDiff, combined };
}

/**
 * Cheap detector for combined merge diffs: diff --cc/--combined headers or well-formed
 * @@@ combined hunk headers outside ordinary hunk bodies. Detection only - no validation.
 */
export function hasCombinedDiff(bytes: Uint8Array): boolean {
    return scanContent(toBuffer(bytes), noop).combined;
}

function finishMessage(
    raw: Buffer,
    start: number,
    end: number,
    metadata: PatchMetadata,
    headers: MailHeaders | undefined,
    check: Check,
): PatchMessage {
    const bytes = raw.subarray(start, end);
    let decodedBytes: Buffer | undefined;
    let encodingError: string | undefined;
    if (headers) {
        const mediaType = headers.contentType?.split(';', 1)[0].trim().toLowerCase();
        const encoding = (headers.encoding ?? '').trim().toLowerCase() || '7bit';
        if (mediaType?.startsWith('multipart/')) {
            encodingError = `Multipart MIME messages are unsupported (Content-Type: ${mediaType}).`;
        } else if (encoding === 'quoted-printable' || encoding === 'base64') {
            const bodyStart = Math.min(headers.bodyStart, end);
            const body = raw.subarray(bodyStart, end);
            const decoded = encoding === 'base64'
                ? decodeBase64(body, check) : decodeQuotedPrintable(body, check);
            if (decoded === undefined) {
                encodingError = 'The message body is not valid base64 (Content-Transfer-Encoding: base64).';
            } else {
                decodedBytes = Buffer.concat([raw.subarray(start, bodyStart), decoded]);
            }
        } else if (!PASSTHROUGH_ENCODINGS.includes(encoding)) {
            encodingError = `Unsupported Content-Transfer-Encoding: ${encoding}.`;
        }
    }
    const scan = scanContent(decodedBytes ?? bytes, check);
    return {
        bytes,
        metadata,
        hasDiff: scan.hasDiff,
        ...decodedBytes ? { decodedBytes } : {},
        ...scan.combined ? { combined: true } : {},
        ...encodingError ? { encodingError } : {},
    };
}

/**
 * Splits mail envelopes into byte-preserving messages, including signatures and cover letters.
 * `bytes` always shares input storage, so concatenating every `bytes` reproduces the input;
 * when a mailbox message declares a quoted-printable or base64 transfer encoding its decoded
 * form is exposed separately as `decodedBytes`, and `hasDiff` plus the `combined` flag are
 * detected on the decoded content. Undecodable bodies set `encodingError` instead of throwing.
 * Non-text bytes are intentionally accepted here.
 */
export function splitPatchMessages(bytes: Uint8Array): readonly PatchMessage[] {
    return splitMessages(bytes, noop);
}

function splitMessages(bytes: Uint8Array, check: Check): readonly PatchMessage[] {
    const raw = toBuffer(bytes);
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
    let current = mailbox ? headers : undefined;
    let start = 0;
    const messages: PatchMessage[] = [];
    for (let offset = first.start; offset < raw.length;) {
        check();
        const line = byteLine(raw, offset);
        offset = line.next;
        if (mailbox && line.start !== first.start) {
            const nextCommit = envelopeCommit(raw, line);
            const nextHeaders = nextCommit ? mailHeaders(raw, line.next, check) : undefined;
            if (nextHeaders?.complete) {
                messages.push(finishMessage(raw, start, line.start, metadata, current, check));
                start = line.start;
                metadata = { commit: revisionCommit(nextCommit), ...nextHeaders.metadata };
                current = nextHeaders;
            }
        }
    }
    messages.push(finishMessage(raw, start, raw.length, metadata, current, check));
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
                fail(`Truncated hunk: expected ${oldLeft} original and ${newLeft} new lines, but found`
                    + ` "${line.text.slice(0, 40)}". Hunk body lines start with a space, "-", or "+";`
                    + ' a context line that lost its leading space is the usual cause', line);
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

/** Resolves the text a message's parser consumes, honoring transfer decoding and its errors. */
function messageText(message: PatchMessage): string {
    if (message.encodingError) {
        throw new PatchParseError(message.encodingError);
    }
    if (message.decodedBytes && !isUtf8(message.decodedBytes)) {
        fail('The decoded message body is not valid UTF-8; use the repository-backed viewer for non-text bytes');
    }
    return (message.decodedBytes ?? message.bytes).toString('utf8').replace(/^\uFEFF/, '');
}

function parseMessage(message: PatchMessage, budget: ContentBudget): HunkPatchPart {
    const lines = new Lines(messageText(message));
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
        if (COMBINED_HEADER.test(text) || text.startsWith('@@@')) {
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
            fail(`Unexpected patch content: ${text.slice(0, 80)}. If this follows a hunk, the "@@" header`
                + ' counts are smaller than its body; context lines keep one leading space', line);
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

class CombinedBuilder {
    private parents = 0;
    private added = false;
    private deleted = false;
    private createdHeader = false;
    private deletedHeader = false;
    private parentModes?: readonly string[];
    private resultMode?: string;
    private parentIds?: readonly string[];
    private resultId?: string;
    private oldPaths?: readonly string[];
    private textHeaders = false;
    private hasHunks = false;
    private readonly before: (Side | undefined)[] = [];
    private readonly after: (Side | undefined)[] = [];
    private oldEnds: number[] = [];
    private newEnd = 0;

    constructor(private readonly path: string, private readonly budget: ContentBudget) {}

    private arity(count: number, line?: TextLine): void {
        if (count < 2 || count > 128) {
            fail('A combined diff must have between 2 and 128 merge parents', line);
        }
        if (this.parents === 0) {
            this.parents = count;
            this.oldEnds = new Array<number>(count).fill(0);
            this.before.length = count;
            this.after.length = count;
        } else if (this.parents !== count) {
            fail('Inconsistent merge parent counts in a combined diff', line);
        }
    }

    private oldPathFor(index: number): string {
        const old = this.oldPaths?.[this.oldPaths.length > 1 ? index : 0];
        return old === undefined || old === '/dev/null' ? this.path : old;
    }

    private addedFor(index: number): boolean {
        return this.added || this.oldPaths?.[this.oldPaths.length > 1 ? index : 0] === '/dev/null';
    }

    metadata(text: string, line: TextLine): boolean {
        const index = /^index ([0-9a-fA-F]{1,64}(?:,[0-9a-fA-F]{1,64})+)\.\.([0-9a-fA-F]{1,64})$/.exec(text);
        const mode = /^mode ([0-7]{6}(?:,[0-7]{6})+)\.\.([0-7]{6})$/.exec(text);
        const created = /^new file mode ([0-7]{6})$/.exec(text);
        const removed = /^deleted file mode ([0-7]{6}(?:,[0-7]{6})+)$/.exec(text);
        if (!index && !mode && !created && !removed) {
            if (/^(?:old mode|new mode|new file mode|deleted file mode|index |mode |rename |copy |similarity |dissimilarity )/
                .test(text)) {
                fail('Malformed or non-combined extended header in a combined diff', line);
            }
            return false;
        }
        if (this.textHeaders || this.hasHunks) {
            fail('Extended diff header occurs after file content', line);
        }
        if (index) {
            const ids = index[1].split(',');
            this.arity(ids.length, line);
            this.parentIds = ids;
            this.resultId = index[2];
        } else if (mode) {
            const modes = mode[1].split(',');
            this.arity(modes.length, line);
            this.parentModes = modes;
            this.resultMode = mode[2];
        } else if (created) {
            this.added = true;
            this.createdHeader = true;
            this.resultMode = created[1];
        } else if (removed) {
            const modes = removed[1].split(',');
            this.arity(modes.length, line);
            this.deleted = true;
            this.deletedHeader = true;
            this.parentModes = modes;
        }
        return true;
    }

    /** Consumes the from-file/to-file block: one `---` per input, or N with --combined-all-paths. */
    headerPaths(lines: Lines, check: Check): void {
        if (this.textHeaders || this.hasHunks) {
            fail('Repeated from-file/to-file headers in a combined diff', lines.peek());
        }
        const olds: string[] = [];
        for (let line = lines.peek(); line?.text.startsWith('--- '); line = lines.peek()) {
            if (olds.length >= 128) {
                fail('A combined diff must have between 2 and 128 merge parents', line);
            }
            olds.push(headerPath(line.text.slice(4), check));
            lines.take();
        }
        const to = lines.peek();
        if (!to?.text.startsWith('+++ ')) {
            fail('Combined --- headers must be followed by a +++ header', to);
        }
        lines.take();
        const next = headerPath(to.text.slice(4), check);
        if (olds.length > 1) {
            this.arity(olds.length, to);
        }
        if (next === '/dev/null') {
            if (olds.every(path => path === '/dev/null')) {
                fail('Both file sides are /dev/null', to);
            }
            this.deleted = true;
        } else if (olds.every(path => path === '/dev/null')) {
            this.added = true;
        }
        this.oldPaths = olds.map(path =>
            path !== '/dev/null' && path.startsWith('a/') ? path.slice(2) : path);
        this.textHeaders = true;
    }

    private sides(): void {
        for (let i = 0; i < this.parents; i++) {
            if (!this.addedFor(i) && !this.before[i]) {
                this.before[i] = new Side('Original', this.budget);
            }
            if (!this.deleted && !this.after[i]) {
                this.after[i] = new Side('New', this.budget);
            }
        }
    }

    hunk(lines: Lines): void {
        const header = lines.take();
        if (!header) {
            return;
        }
        const match = COMBINED_HUNK.exec(header.text);
        if (!match) {
            fail('Malformed combined hunk header', header);
        }
        const tokens = match[2].trimEnd().split(' ');
        if (tokens.length !== match[1].length - 1) {
            fail('Combined hunk ranges do not match the header @ count', header);
        }
        this.arity(tokens.length, header);
        const old = tokens.map(token => {
            const parts = /^-(\d+)(?:,(\d+))?$/.exec(token);
            return parts ? range(parts[1], parts[2], header) : fail('Malformed combined hunk header', header);
        });
        const next = range(match[3], match[4], header);
        if (next.count === 0 && old.every(side => side.count === 0)) {
            fail('A hunk must contain at least one line', header);
        }
        if (this.deleted && next.count !== 0) {
            fail('A deleted file has lines on its absent side', header);
        }
        const newPosition = next.start + (next.count === 0 ? 1 : 0);
        if (newPosition < this.newEnd) {
            fail('Hunk ranges overlap or are out of order', header);
        }
        this.newEnd = newPosition + next.count;
        for (let i = 0; i < this.parents; i++) {
            if (this.addedFor(i) && old[i].count !== 0) {
                fail('An added file has lines on its absent side', header);
            }
            const position = old[i].start + (old[i].count === 0 ? 1 : 0);
            if (position < this.oldEnds[i]) {
                fail('Hunk ranges overlap or are out of order', header);
            }
            this.oldEnds[i] = position + old[i].count;
        }
        this.sides();
        for (let i = 0; i < this.parents; i++) {
            this.before[i]?.hunk(old[i].start, old[i].count);
            this.after[i]?.hunk(next.start, next.count);
        }
        const left = old.map(side => side.count);
        let resultLeft = next.count;
        while (resultLeft > 0 || left.some(count => count > 0)) {
            this.budget.check();
            const line = lines.take();
            if (!line) {
                fail('Truncated combined hunk: declared parent or result lines are missing', header);
            }
            if (line.text === NO_NEWLINE) {
                fail('The combined diff format does not carry no-newline markers', line);
            }
            const columns = line.text.slice(0, this.parents);
            if (columns.length < this.parents || /[^ +-]/.test(columns)) {
                fail('Malformed combined hunk line prefix', line);
            }
            const lost = columns.includes('-');
            if (lost && columns.includes('+')) {
                fail('A combined hunk line mixes - and + columns', line);
            }
            if (!lost && --resultLeft < 0) {
                fail('Hunk content exceeds the declared line counts', line);
            }
            const text = line.text.slice(this.parents);
            for (let i = 0; i < this.parents; i++) {
                const column = columns[i];
                if (column === '-' || !lost && column === ' ') {
                    if (--left[i] < 0) {
                        fail('Hunk content exceeds the declared line counts', line);
                    }
                    this.before[i]?.append(text);
                    this.before[i]?.append(line.ending);
                }
                if (!lost) {
                    this.after[i]?.append(text);
                    this.after[i]?.append(line.ending);
                }
            }
        }
        this.hasHunks = true;
    }

    private statusFor(index: number, oldPath: string, added: boolean): HunkFile['status'] {
        if (added) {
            return 'A';
        }
        if (this.deleted) {
            return 'D';
        }
        if (oldPath !== this.path) {
            return 'R';
        }
        const oldMode = this.parentModes?.[index];
        return oldMode && this.resultMode && oldMode.slice(0, 3) !== this.resultMode.slice(0, 3) ? 'T' : 'M';
    }

    finish(): CombinedFile {
        if (this.added && this.deleted) {
            fail('Contradictory added and deleted combined file metadata');
        }
        if (this.textHeaders && !this.hasHunks) {
            fail('File headers have no hunks; the combined patch may be truncated');
        }
        if (this.parents === 0) {
            fail(`The combined diff for ${this.path} declares no parent information`);
        }
        if (!this.hasHunks && !this.added && !this.deleted && !(this.parentModes && this.resultMode)) {
            fail('A combined diff header has no changes; the patch may be truncated');
        }
        if (!this.hasHunks) {
            this.sides();
            for (const side of this.before) {
                side?.unavailable(false);
            }
            for (const side of this.after) {
                side?.unavailable(false);
            }
        }
        const perParent: HunkFile[] = [];
        for (let i = 0; i < this.parents; i++) {
            const oldPath = this.oldPathFor(i);
            const added = this.addedFor(i);
            perParent.push({
                status: this.statusFor(i, oldPath, added),
                oldPath: validPath(oldPath),
                newPath: validPath(this.deleted ? oldPath : this.path),
                before: this.before[i]?.bytes(),
                after: this.after[i]?.bytes(),
                oldMode: this.createdHeader ? '000000' : this.parentModes?.[i],
                newMode: this.deletedHeader ? '000000' : this.resultMode,
                oldId: this.parentIds?.[i],
                newId: this.resultId,
                hasHunks: this.hasHunks,
            });
        }
        return { path: this.path, parents: this.parents, perParent };
    }
}

function parseCombinedMessage(message: PatchMessage, budget: ContentBudget): CombinedPatchPart {
    const lines = new Lines(messageText(message));
    const files: CombinedFile[] = [];
    let file: CombinedBuilder | undefined;
    const finish = () => {
        if (file) {
            files.push(file.finish());
            file = undefined;
        }
    };
    for (let line = lines.peek(); line; line = lines.peek()) {
        budget.check();
        const text = line.text;
        if (COMBINED_HEADER.test(text)) {
            finish();
            const path = text.startsWith('diff --cc') ? text.slice(10) : text.slice(16);
            file = new CombinedBuilder(headerPath(path, budget.check), budget);
            lines.take();
        } else if (/^diff --git(?: |$)/.test(text)) {
            fail('Ordinary two-sided diff content is not a combined diff; parse it with parseHunks', line);
        } else if (file && text.startsWith('--- ')) {
            file.headerPaths(lines, budget.check);
        } else if (text.startsWith('@@@')) {
            if (!file) {
                fail('A combined hunk has no diff --cc or --combined header', line);
            }
            file.hunk(lines);
        } else if (text.startsWith('@@')) {
            fail('Ordinary two-sided diff content is not a combined diff; parse it with parseHunks', line);
        } else if (file?.metadata(text, line)) {
            lines.take();
        } else if (text === '-- ') {
            finish();
            break;
        } else if (text === '') {
            lines.take();
        } else if (file || text.startsWith('--- ') || text.startsWith('+++ ') || text === NO_NEWLINE) {
            fail(`Unexpected combined patch content: ${text.slice(0, 80)}`, line);
        } else {
            lines.take();
        }
    }
    finish();
    return { metadata: message.metadata, files };
}

/**
 * Parses combined merge diffs (diff --cc / --combined) into per-parent partial-context views.
 * perParent[i] shows the change versus parent i+1 using only lines the combined text carries:
 * column i of every hunk line selects the parent-i side per the COMBINED DIFF FORMAT section of
 * the Git diff documentation, and the i-th @@@ from-file-range supplies the parent-i line range.
 * A line whose columns include `-` exists only on parent sides marked `-`; other lines belong to
 * the result, as context for parents marked with a space. Hunks where a parent already matches
 * the result stay as pure context for that parent, omitted context stays explicitly labelled,
 * and nothing absent from the combined text is ever fabricated. The combined format carries no
 * no-newline markers, so such input is rejected rather than guessed at. Combined mode and index
 * header lines surface as per-parent oldMode/newMode/oldId/newId metadata.
 */
export function parseCombinedParts(
    bytes: Uint8Array,
    options: OperationOptions = {},
): readonly CombinedPatchPart[] {
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
    const parts = splitMessages(bytes, check).map(message => parseCombinedMessage(message, budget));
    if (!parts.some(part => part.files.length > 0)) {
        fail('The input contains no combined file diffs');
    }
    check();
    return parts;
}
