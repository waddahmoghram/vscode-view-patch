import { existsSync } from 'fs';
import { spawn } from 'child_process';

/** A Git command that failed. The message is Git's own explanation when it printed one. */
export class GitError extends Error {
    constructor(message: string, readonly args: readonly string[], readonly exitCode: number | null) {
        super(message);
        this.name = 'GitError';
    }
}

export interface GitOptions {
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

/** Runs one Git executable, without a shell. */
export class Git {
    constructor(readonly path: string = 'git') {}

    /** Runs `git args` and resolves with its standard output, or rejects with a GitError. */
    run(args: readonly string[], options: GitOptions): Promise<Buffer> {
        const env: Record<string, string | undefined> = { ...process.env };
        for (const name of LOCATION_VARIABLES) {
            delete env[name];
        }
        Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, options.env);
        // A repository can name a file-system monitor program in core.fsmonitor; these commands never need one.
        const argv = ['-c', 'core.fsmonitor=false', ...args];

        return new Promise((resolve, reject) => {
            const child = spawn(this.path, argv, { cwd: options.cwd, env, windowsHide: true });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let failed = false;

            child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
            // Git can exit before reading all of its input; its exit status says why.
            child.stdin.on('error', () => undefined);
            child.on('error', (error: NodeJS.ErrnoException) => {
                failed = true;
                reject(new GitError(startFailure(error, this.path, options.cwd), args, null));
            });
            child.on('close', (code, signal) => {
                if (failed) {
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
            child.stdin.end(options.input ?? '');
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

// Node reports a missing working folder and a missing executable with the same ENOENT error.
function startFailure(error: NodeJS.ErrnoException, gitPath: string, cwd: string): string {
    if (error.code !== 'ENOENT') {
        return error.message;
    }
    return existsSync(cwd) ? `Git was not found at "${gitPath}".` : `The folder "${cwd}" does not exist.`;
}
