import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { performance } from 'perf_hooks';
import {
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_TIMEOUT_MS,
    OperationCancelledError,
    OperationLimitError,
    OperationOptions,
    OperationTimeoutError,
    positiveLimit,
    throwIfAborted,
} from './operations';

/** A Git command that failed. The message is Git's own explanation when it printed one. */
export class GitError extends Error {
    constructor(message: string, readonly args: readonly string[], readonly exitCode: number | null) {
        super(message);
        this.name = 'GitError';
    }
}

export interface GitOptions extends OperationOptions {
    /** The folder to run Git in. */
    readonly cwd: string;
    /** Environment variables to add for this command. */
    readonly env?: Readonly<Record<string, string>>;
    /** Bytes for Git's standard input. */
    readonly input?: string | Uint8Array;
}

// Variables that would point Git at something other than the repository found from the working folder.
const LOCATION_VARIABLES = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
];

const KILL_GRACE_MS = 250;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Runs one Git executable, without a shell. */
export class Git {
    constructor(readonly path: string = 'git', private readonly argumentPrefix: readonly string[] = []) {}

    /** Runs `git args`, rejecting on failure, cancellation, timeout, or excess combined output. */
    run(args: readonly string[], options: GitOptions): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            throwIfAborted(options.signal);
            const timeoutMs = positiveLimit('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            const maxOutputBytes = positiveLimit('maxOutputBytes', options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
            const hasInput = (options.input?.length ?? 0) > 0;
            const env: Record<string, string | undefined> = { ...process.env };
            for (const name of LOCATION_VARIABLES) {
                delete env[name];
            }
            Object.assign(env, options.env, {
                GIT_TERMINAL_PROMPT: '0',
                GIT_OPTIONAL_LOCKS: '0',
                GIT_NO_LAZY_FETCH: '1',
            });
            // Block lazy-fetch transports and repository-configured file-system monitors.
            const argv = [
                ...this.argumentPrefix,
                '-c', 'core.fsmonitor=false',
                '-c', 'protocol.allow=never',
                ...args,
            ];
            const child = spawn(this.path, argv, { cwd: options.cwd, env, windowsHide: true });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const started = performance.now();
            let outputBytes = 0;
            let failure: Error | undefined;
            let inputError: NodeJS.ErrnoException | undefined;
            let timeout: NodeJS.Timeout | undefined;
            let escalation: NodeJS.Timeout | undefined;

            const terminate = (error: Error): void => {
                if (failure) {
                    return;
                }
                failure = error;
                clearTimeout(timeout);
                child.kill('SIGTERM');
                escalation = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill('SIGKILL');
                    }
                }, KILL_GRACE_MS);
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            };

            const capture = (chunk: Buffer, chunks: Buffer[]): void => {
                if (failure) {
                    return;
                }
                if (chunk.length > maxOutputBytes - outputBytes) {
                    terminate(new OperationLimitError(`Git output exceeds the ${maxOutputBytes}-byte limit.`));
                    return;
                }
                outputBytes += chunk.length;
                chunks.push(chunk);
            };

            const onAbort = (): void => terminate(new OperationCancelledError());
            const onTimeout = (): void => {
                const remaining = timeoutMs - (performance.now() - started);
                if (remaining > 0) {
                    timeout = setTimeout(onTimeout, Math.min(remaining, MAX_TIMER_DELAY_MS));
                } else {
                    terminate(new OperationTimeoutError(timeoutMs));
                }
            };

            const onStdout = (chunk: Buffer): void => capture(chunk, stdout);
            const onStderr = (chunk: Buffer): void => capture(chunk, stderr);
            const onStdoutError = (): void => {
                terminate(new GitError('Could not read Git standard output.', args, null));
            };
            const onStderrError = (): void => {
                terminate(new GitError('Could not read Git standard error.', args, null));
            };
            const onInputError = (error: NodeJS.ErrnoException): void => {
                inputError = error;
                if (!isBrokenPipe(error)) {
                    terminate(new GitError('Could not write Git standard input.', args, null));
                }
            };
            const onChildError = (error: NodeJS.ErrnoException): void => {
                failure ??= new GitError(startFailure(error, this.path, options.cwd), args, null);
            };

            child.stdout.on('data', onStdout);
            child.stderr.on('data', onStderr);
            child.stdout.on('error', onStdoutError);
            child.stderr.on('error', onStderrError);
            child.stdin.on('error', onInputError);
            child.on('error', onChildError);
            child.once('close', (code, signal) => {
                clearTimeout(timeout);
                clearTimeout(escalation);
                options.signal?.removeEventListener('abort', onAbort);
                child.stdout.removeListener('data', onStdout);
                child.stderr.removeListener('data', onStderr);
                child.stdout.removeListener('error', onStdoutError);
                child.stderr.removeListener('error', onStderrError);
                child.stdin.removeListener('error', onInputError);
                child.removeListener('error', onChildError);
                if (failure) {
                    reject(failure);
                    return;
                }
                // Empty-input shutdown can race with success; nonempty input must be accepted or Git must fail.
                const expectedPipeClose = code !== null && (code !== 0 || !hasInput);
                if (inputError && !(expectedPipeClose && isBrokenPipe(inputError))) {
                    reject(new GitError('Could not write Git standard input.', args, null));
                    return;
                }
                if (code === 0) {
                    resolve(Buffer.concat(stdout));
                    return;
                }
                const message = Buffer.concat(stderr).toString('utf8').trim();
                const fallback = code === null ? `stopped by ${signal}` : `failed with exit code ${code}`;
                reject(new GitError(message || `git ${args[0]} ${fallback}.`, args, code));
            });
            options.signal?.addEventListener('abort', onAbort, { once: true });
            timeout = setTimeout(onTimeout, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
            if (options.signal?.aborted) {
                onAbort();
            }
            if (!failure) {
                try {
                    if (hasInput) {
                        child.stdin.end(options.input);
                    } else {
                        child.stdin.end();
                    }
                } catch {
                    terminate(new GitError('Could not write Git standard input.', args, null));
                }
            }
        });
    }

    /** Runs `git args` and resolves with its output as text, without the final line break. */
    async text(args: readonly string[], options: GitOptions): Promise<string> {
        return (await this.run(args, options)).toString('utf8').replace(/\r?\n$/, '');
    }

    /** Resolves true when `git args` exits with status 0, and false when it exits with another status. */
    async succeeds(args: readonly string[], options: GitOptions): Promise<boolean> {
        try {
            await this.run(args, options);
            return true;
        } catch (error) {
            if (error instanceof GitError && error.exitCode !== null) {
                return false;
            }
            throw error;
        }
    }
}

function isBrokenPipe(error: NodeJS.ErrnoException): boolean {
    return error.code === 'EPIPE' || error.code === 'ECONNRESET';
}

// Node reports a missing working folder and a missing executable with the same ENOENT error.
function startFailure(error: NodeJS.ErrnoException, gitPath: string, cwd: string): string {
    if (error.code !== 'ENOENT') {
        return error.message;
    }
    return existsSync(cwd) ? `Git was not found at "${gitPath}".` : `The folder "${cwd}" does not exist.`;
}
