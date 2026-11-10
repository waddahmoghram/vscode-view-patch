import {
    DEFAULT_MAX_PATCH_BYTES, OperationLimitError, OperationOptions, positiveLimit, throwIfAborted,
} from './operations';
import { splitPatchMessages } from './patchText';

export interface SeriesInput {
    readonly name: string;
    readonly bytes: Uint8Array;
}

export function assembleSeries(inputs: readonly SeriesInput[], options: OperationOptions = {}): Buffer {
    throwIfAborted(options.signal);
    if (inputs.length < 2) {
        throw new Error('Select at least two patch files to open as a series.');
    }
    const limit = positiveLimit('Patch size limit', options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);
    let bytes = 0;
    const numbered = inputs.map(input => {
        throwIfAborted(options.signal);
        bytes += input.bytes.length;
        checkLimit(bytes, limit);
        const messages = splitPatchMessages(input.bytes);
        const metadata = (messages.find(message => message.hasDiff) ?? messages[0])?.metadata;
        const fromName = /^(\d+)[-_.]/.exec(input.name);
        const number = metadata?.index ?? (fromName ? Number(fromName[1]) : undefined);
        return { input, number };
    });
    if (numbered.every(item => item.number !== undefined)) {
        numbered.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
        for (let index = 1; index < numbered.length; index++) {
            if (numbered[index].number === numbered[index - 1].number) {
                throw new Error(`More than one selected file is numbered ${numbered[index].number}.`);
            }
        }
    }
    const chunks: Buffer[] = [];
    bytes = 0;
    for (const { input } of numbered) {
        for (const message of splitPatchMessages(input.bytes)) {
            throwIfAborted(options.signal);
            let chunk = message.bytes;
            if (!/^From [0-9a-f]{40,64} /m.test(chunk.subarray(0, 100).toString('ascii'))) {
                const commit = /^[0-9a-f]{40,64}$/.test(message.metadata.commit ?? '')
                    ? message.metadata.commit : '0'.repeat(40);
                const subject = (message.metadata.subject ?? input.name).replace(/[\r\n]/g, ' ');
                const header = `From ${commit} Mon Sep 17 00:00:00 2001\nSubject: ${subject}\n\n`;
                chunk = Buffer.concat([Buffer.from(header), chunk]);
            }
            const newline = chunk.length > 0 && chunk[chunk.length - 1] === 10 ? Buffer.alloc(0) : Buffer.from('\n');
            bytes += chunk.length + newline.length + 1;
            checkLimit(bytes, limit);
            chunks.push(chunk, newline, Buffer.from('\n'));
        }
    }
    return Buffer.concat(chunks, bytes);
}

function checkLimit(bytes: number, limit: number): void {
    if (bytes > limit) {
        throw new OperationLimitError(`The assembled patch series exceeds the ${limit}-byte input limit.`);
    }
}
