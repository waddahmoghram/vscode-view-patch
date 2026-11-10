export interface OperationOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxPatchBytes?: number;
    readonly maxContentBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_PATCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;

export class OperationCancelledError extends Error {
    constructor() {
        super('Patch viewing was cancelled.');
        this.name = 'OperationCancelledError';
    }
}

export class OperationTimeoutError extends Error {
    constructor(readonly timeoutMs: number) {
        super(`Git did not finish within ${timeoutMs} milliseconds.`);
        this.name = 'OperationTimeoutError';
    }
}

export class OperationLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OperationLimitError';
    }
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new OperationCancelledError();
    }
}

export function positiveLimit(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive whole number.`);
    }
    return value;
}
