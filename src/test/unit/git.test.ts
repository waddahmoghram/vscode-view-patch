import * as assert from 'node:assert/strict';
import childProcess = require('node:child_process');
import { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, mock, test, TestContext } from 'node:test';
import { Git, GitError, GitOptions } from '../../git';
import { OperationCancelledError, OperationLimitError, OperationTimeoutError } from '../../operations';

const root = mkdtempSync(path.join(process.cwd(), '.git tests-'));
let serial = 0;

const fixture = `
const fs = require('node:fs');
const mode = process.env.VIEW_PATCH_GIT_MODE;
if (mode === 'inspect') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({
            args: process.argv.slice(1),
            cwd: process.cwd(),
            input,
            location: process.env.GIT_DIR,
            index: process.env.GIT_INDEX_FILE,
            prompt: process.env.GIT_TERMINAL_PROMPT,
            locks: process.env.GIT_OPTIONAL_LOCKS,
            lazyFetch: process.env.GIT_NO_LAZY_FETCH,
        }));
    });
} else if (mode === 'hang' || mode === 'flood') {
    process.on('SIGTERM', () => {
        if (process.env.VIEW_PATCH_GIT_TERM) {
            fs.writeFileSync(process.env.VIEW_PATCH_GIT_TERM, 'SIGTERM');
        }
    });
    if (process.env.VIEW_PATCH_GIT_READY) {
        fs.writeFileSync(process.env.VIEW_PATCH_GIT_READY, String(process.pid));
    }
    setInterval(() => {
        if (mode === 'flood') {
            process.stderr.write('0123456789');
        }
    }, 10);
} else if (mode === 'early-failure' || mode === 'early-success') {
    process.stderr.write(mode === 'early-failure' ? 'fixture failure' : '', () => {
        const exit = () => process.exit(mode === 'early-failure' ? 7 : 0);
        const delay = Number(process.env.VIEW_PATCH_GIT_EXIT_DELAY || 0);
        if (delay) {
            setTimeout(exit, delay);
        } else {
            exit();
        }
    });
} else if (mode === 'text') {
    process.stdout.write('value\\r\\n');
} else if (mode === 'unicode') {
    process.stdout.write('\\u00e9');
} else {
    process.stdout.write(Buffer.alloc(Number(process.env.VIEW_PATCH_GIT_OUT || 0), 0x6f));
    process.stderr.write(Buffer.alloc(Number(process.env.VIEW_PATCH_GIT_ERR || 0), 0x65));
    process.exitCode = Number(process.env.VIEW_PATCH_GIT_EXIT || 0);
}
`;

const fixtureGit = new Git(process.execPath, ['-e', fixture, '--']);

after(() => rmSync(root, { recursive: true, force: true }));

function options(
    mode: string,
    extra: Partial<GitOptions> = {},
    env: Readonly<Record<string, string>> = {},
): GitOptions {
    return { cwd: root, ...extra, env: { VIEW_PATCH_GIT_MODE: mode, ...env, ...extra.env } };
}

function trackChild(
    context: TestContext,
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): { child?: ChildProcessWithoutNullStreams; closed: boolean; count: number } {
    const state: { child?: ChildProcessWithoutNullStreams; closed: boolean; count: number } = {
        closed: false,
        count: 0,
    };
    const original = childProcess.spawn;
    const mocked = mock.method(childProcess, 'spawn', (
        file: string,
        args: readonly string[],
        spawnOptions: SpawnOptionsWithoutStdio,
    ) => {
        const child = original(file, args, spawnOptions);
        state.child = child;
        state.count++;
        child.once('close', () => { state.closed = true; });
        if (onSpawn) {
            child.once('spawn', () => onSpawn(child));
        }
        return child;
    });
    context.after(() => mocked.mock.restore());
    return state;
}

async function waitForFile(file: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!existsSync(file)) {
        if (Date.now() >= deadline) {
            throw new Error('The child fixture did not become ready.');
        }
        await delay(10);
    }
}

describe('bounded Git execution', () => {
    test('rejects an already aborted operation without spawning', async context => {
        const state = trackChild(context);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(fixtureGit.run([], options('hang', {
            signal: controller.signal,
        })), OperationCancelledError);
        assert.equal(state.count, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });

    test('cancels a running child, escalates, and waits for close', async context => {
        const state = trackChild(context);
        const controller = new AbortController();
        const ready = path.join(root, `ready-${serial++}`);
        const term = path.join(root, `term-${serial++}`);
        const running = fixtureGit.run([], options('hang', {
            signal: controller.signal,
            timeoutMs: 10_000,
        }, { VIEW_PATCH_GIT_READY: ready, VIEW_PATCH_GIT_TERM: term }));
        const rejection = assert.rejects(running, OperationCancelledError);
        try {
            await waitForFile(ready);
            controller.abort();
            await rejection;
            assert.equal(state.closed, true);
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            if (process.platform !== 'win32') {
                assert.equal(readFileSync(term, 'utf8'), 'SIGTERM');
                assert.equal(state.child?.signalCode, 'SIGKILL');
            }
        } finally {
            controller.abort();
            await running.catch(() => undefined);
        }
    });

    test('times out and reaps the child before rejecting', async context => {
        const state = trackChild(context);
        const controller = new AbortController();
        await assert.rejects(fixtureGit.run([], options('hang', {
            timeoutMs: 100,
            signal: controller.signal,
        })), (error: unknown) => error instanceof OperationTimeoutError && error.timeoutMs === 100);
        assert.equal(state.closed, true);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });

    for (const [label, stdout, stderr] of [
        ['stdout', 8, 0],
        ['stderr', 0, 8],
        ['combined streams', 4, 4],
    ] as const) {
        test(`accepts exactly the ${label} limit and rejects one byte more`, async () => {
            const env = { VIEW_PATCH_GIT_OUT: String(stdout), VIEW_PATCH_GIT_ERR: String(stderr) };
            const output = await fixtureGit.run([], options('output', { maxOutputBytes: 8 }, env));
            assert.equal(output.length, stdout);
            await assert.rejects(
                fixtureGit.run([], options('output', { maxOutputBytes: 7 }, env)),
                OperationLimitError,
            );
        });
    }

    test('counts bytes rather than decoded characters', async () => {
        assert.equal((await fixtureGit.run([], options('unicode', { maxOutputBytes: 2 }))).toString(), '\u00e9');
        await assert.rejects(fixtureGit.run([], options('unicode', { maxOutputBytes: 1 })), OperationLimitError);
    });

    test('terminates an unbounded stderr producer at the combined output cap', async context => {
        const state = trackChild(context);
        const controller = new AbortController();
        await assert.rejects(fixtureGit.run([], options('flood', {
            maxOutputBytes: 16,
            signal: controller.signal,
        })), OperationLimitError);
        assert.equal(state.closed, true);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });

    test('reports an output limit instead of a normal Git failure', async () => {
        await assert.rejects(fixtureGit.run([], options('output', { maxOutputBytes: 8 }, {
            VIEW_PATCH_GIT_ERR: '9',
            VIEW_PATCH_GIT_EXIT: '7',
        })), OperationLimitError);
    });

    test('validates limits before spawning', async context => {
        const state = trackChild(context);
        for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            for (const name of ['timeoutMs', 'maxOutputBytes'] as const) {
                await assert.rejects(fixtureGit.run([], options('output', {
                    [name]: value,
                })), new RegExp(name));
            }
        }
        assert.equal(state.count, 0);
    });

    test('supports long timeouts without overflowing the native timer', async () => {
        assert.equal((await fixtureGit.run([], options('output', { timeoutMs: 2 ** 32 }))).length, 0);
    });

    test('preserves arguments, input, and sanitized environment in a folder with spaces', async () => {
        const previous = process.env.GIT_DIR;
        process.env.GIT_DIR = 'must-not-be-inherited';
        try {
            const args = ['argument with spaces', 'literal; $value & no shell'];
            const output = await fixtureGit.run(args, options('inspect', {
                input: 'input with spaces\n',
                env: { GIT_INDEX_FILE: 'explicit-scratch-index' },
            }));
            const actual: unknown = JSON.parse(output.toString());
            assert.deepEqual(actual, {
                args: ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args],
                cwd: root,
                input: 'input with spaces\n',
                index: 'explicit-scratch-index',
                prompt: '0',
                locks: '0',
                lazyFetch: '1',
            });
        } finally {
            if (previous === undefined) {
                delete process.env.GIT_DIR;
            } else {
                process.env.GIT_DIR = previous;
            }
        }
    });

    test('preserves text and ordinary exit-status results', async () => {
        assert.equal(await fixtureGit.text([], options('text')), 'value');
        assert.equal(await fixtureGit.succeeds([], options('output')), true);
        assert.equal(await fixtureGit.succeeds([], options('output', {}, { VIEW_PATCH_GIT_EXIT: '7' })), false);
    });

    test('cleans cancellation listeners after success', async () => {
        const controller = new AbortController();
        await fixtureGit.run([], options('output', { signal: controller.signal }));
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        controller.abort();
    });

    test('succeeds propagates operation failures rather than returning false', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            fixtureGit.succeeds([], options('output', { signal: controller.signal })),
            OperationCancelledError,
        );
        await assert.rejects(
            fixtureGit.succeeds([], options('hang', { timeoutMs: 50 })),
            OperationTimeoutError,
        );
        await assert.rejects(
            fixtureGit.succeeds([], options('output', { maxOutputBytes: 1 }, { VIEW_PATCH_GIT_ERR: '2' })),
            OperationLimitError,
        );
    });

    test('preserves Git failure diagnostics when Git closes a large input early', async () => {
        await assert.rejects(fixtureGit.run([], options('early-failure', {
            input: Buffer.alloc(4 * 1024 * 1024),
        })), (error: unknown) => {
            return error instanceof GitError && error.exitCode === 7 && error.message === 'fixture failure';
        });
    });

    test('preserves Git failure diagnostics when a platform reports the closed pipe differently', async context => {
        trackChild(context, child => {
            child.stdin.emit('error', Object.assign(new Error('fixture write EOF'), { code: 'EOF' }));
        });
        await assert.rejects(fixtureGit.run([], options('early-failure', {
            input: 'x',
        })), (error: unknown) => {
            return error instanceof GitError && error.exitCode === 7 && error.message === 'fixture failure';
        });
    });

    test('lets a child report a closed-pipe failure within the configured command timeout', async context => {
        const state = trackChild(context, child => {
            child.stdin.emit('error', Object.assign(new Error('fixture write EOF'), { code: 'EOF' }));
        });
        await assert.rejects(fixtureGit.run([], options('early-failure', {
            input: 'x',
            timeoutMs: 10_000,
        }, { VIEW_PATCH_GIT_EXIT_DELAY: '1500' })), (error: unknown) => {
            return error instanceof GitError && error.exitCode === 7 && error.message === 'fixture failure';
        });
        assert.equal(state.closed, true);
    });

    for (const mode of ['early-failure', 'text']) {
        test(`does not hide a genuine input error behind a quick ${mode} result`, async context => {
            const state = trackChild(context, child => {
                child.stdin.emit('error', Object.assign(new Error('fixture input error'), { code: 'EIO' }));
            });
            await assert.rejects(fixtureGit.succeeds([], options(mode)), (error: unknown) => {
                return error instanceof GitError && error.exitCode === null && /standard input/.test(error.message);
            });
            assert.equal(state.closed, true);
        });
    }

    test('rejects a Windows closed-pipe error when a successful child did not accept the input', async context => {
        trackChild(context, child => {
            child.stdin.emit('error', Object.assign(new Error('fixture write EOF'), { code: 'EOF' }));
        });
        await assert.rejects(fixtureGit.run([], options('early-success', {
            input: 'x',
        })), (error: unknown) => {
            return error instanceof GitError && error.exitCode === null && /standard input/.test(error.message);
        });
    });

    test('allows a Windows empty-input shutdown to race with a successful child exit', async context => {
        const state = trackChild(context, child => {
            child.stdin.emit('error', Object.assign(new Error('fixture write EOF'), { code: 'EOF' }));
        });
        assert.equal(await fixtureGit.text([], options('text')), 'value');
        assert.equal(state.closed, true);
    });

    test('rejects an incomplete input even if the child exits successfully', async () => {
        await assert.rejects(fixtureGit.run([], options('early-success', {
            input: Buffer.alloc(4 * 1024 * 1024),
        })), (error: unknown) => {
            return error instanceof GitError && error.exitCode === null && /standard input/.test(error.message);
        });
    });

    test('allows an empty-input shutdown to race with a successful child exit', async context => {
        const state = trackChild(context, child => {
            child.stdin.emit('error', Object.assign(new Error('fixture pipe closed'), { code: 'EPIPE' }));
        });
        assert.equal(await fixtureGit.text([], options('text')), 'value');
        assert.equal(state.closed, true);
    });

    test('terminates on a genuine input error and does not turn it into false', async context => {
        const state = trackChild(context, child => {
            child.stdin.emit('error', Object.assign(new Error('fixture input error'), { code: 'EIO' }));
        });
        await assert.rejects(fixtureGit.succeeds([], options('hang')), (error: unknown) => {
            return error instanceof GitError && error.exitCode === null && /standard input/.test(error.message);
        });
        assert.equal(state.closed, true);
    });

    test('terminates on a read error and waits for close', async context => {
        const state = trackChild(context, child => {
            child.stderr.emit('error', new Error('fixture read error'));
        });
        await assert.rejects(fixtureGit.run([], options('hang')), (error: unknown) => {
            return error instanceof GitError && error.exitCode === null && /standard error/.test(error.message);
        });
        assert.equal(state.closed, true);
    });

    test('waits for close after an executable-start failure and cleans cancellation listeners', async context => {
        const state = trackChild(context);
        const controller = new AbortController();
        const missing = new Git(path.join(root, 'missing-git'));
        await assert.rejects(missing.run([], options('output', { signal: controller.signal })), GitError);
        assert.equal(state.closed, true);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});
