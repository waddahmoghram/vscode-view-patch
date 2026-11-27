// Where release check A runs its shell steps, and a throwaway sshd for trying its Remote - SSH mode.
//
// localHost() runs POSIX shell scripts on this computer and sshHost() on an ssh host alias. The check sends both the
// same scripts, so a local run also exercises what a Remote - SSH run sends to its host. startLocalSshd() serves CI
// runners and local verification: a user-level sshd on 127.0.0.1 that accepts one throwaway key, with every file in
// a private scratch folder. Neither it nor the ssh configuration it writes reads or changes ~/.ssh. vscodeAppFolder()
// finds the files of the VS Code that the check downloads, on each platform.

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const LOCAL_SSH_ALIAS = 'vp-check-a-localhost';
const SSHD = '/usr/sbin/sshd';
const MARK = '@@view-patch-check-a';
const windows = process.platform === 'win32';
const running = new Set();

/** Quotes a value for a POSIX shell. */
export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The last few non-empty lines of a program's output, for an error message. */
export function lastLines(text, count = 4) {
    return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-count).join(' / ');
}

/**
 * The folder that holds the package.json and product.json of a downloaded VS Code, given its executable. Windows
 * archives put it in a folder named after the first 10 characters of the commit, beside Code.exe, such as
 * 661626d0e7/resources/app in 1.148.0 (microsoft/vscode#249239); older ones put it directly in resources/app.
 */
export function vscodeAppFolder(executable, platform = process.platform) {
    const dir = path.dirname(executable);
    if (platform === 'darwin') {
        return path.join(path.dirname(dir), 'Resources', 'app');
    }
    const flat = path.join(dir, 'resources', 'app');
    if (platform !== 'win32' || existsSync(path.join(flat, 'package.json'))) {
        return flat;
    }
    const versioned = readdirSync(dir)
        .filter(name => /^[0-9a-f]{10}$/.test(name))
        .map(name => path.join(dir, name, 'resources', 'app'))
        .filter(folder => existsSync(path.join(folder, 'package.json')));
    if (versioned.length !== 1) {
        throw new Error(`VS Code's files are in neither ${flat} nor one commit-named folder beside`
            + ` ${path.basename(executable)}: found ${versioned.length} such folders`);
    }
    return versioned[0];
}

/** Stops a program that run() or the VS Code launch started, with everything it started, if any of it is left. */
export function killTree(pid) {
    if (!pid) {
        return;
    }
    if (windows) {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
        return;
    }
    try {
        // Each such program leads its own process group.
        process.kill(-pid, 'SIGKILL');
    } catch {
        // Nothing is left of it.
    }
}

/**
 * Runs a program to completion and collects its output. Rejects when the program cannot start or runs longer than
 * `timeoutMs`; any exit code is returned as `status`.
 */
export function run(command, args, { input, timeoutMs = 120_000, env, shell = false } = {}) {
    return new Promise((resolve, reject) => {
        // A process group of its own, so that a timeout or an interrupt also stops what it started, such as git under
        // sh. Windows has no process groups, and would open a console for a detached program.
        const child = spawn(command, args, { env, shell, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] });
        running.add(child);
        const stdout = [];
        const stderr = [];
        const timer = setTimeout(() => {
            killTree(child.pid);
            reject(new Error(`${path.basename(command)} did not finish within ${timeoutMs / 1000} s`));
        }, timeoutMs);
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', error => {
            clearTimeout(timer);
            running.delete(child);
            reject(error);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            running.delete(child);
            resolve({
                status: code ?? signal,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
        // A program that exits without reading its input closes the pipe early; its exit code says what happened.
        child.stdin.on('error', () => {});
        child.stdin.end(input ?? '');
    });
}

/** Stops every program that run() started and that is still running, with what it started. */
export function stopRunning() {
    for (const child of running) {
        killTree(child.pid);
    }
    running.clear();
}

/** This computer, whose shell scripts run in `sh`: on Windows, the one that Git for Windows installs. */
export function localHost() {
    return {
        label: 'this computer',
        sh: (script, { timeoutMs } = {}) => run('sh', ['-s'], { input: script, timeoutMs }),
        writeFile: (file, data) => writeFile(file, data),
    };
}

/**
 * A host reached with `ssh [-F configFile] alias`. Scripts go to `sh -s` on its standard input; shSync() serves the
 * cleanup in a signal handler, which cannot wait for promises.
 */
export function sshHost(alias, configFile) {
    // BatchMode makes ssh fail instead of asking for a password or passphrase that nobody would type.
    const ssh = ['-o', 'BatchMode=yes', ...(configFile ? ['-F', configFile] : []), alias];
    return {
        label: alias,
        sh: (script, { timeoutMs } = {}) => run('ssh', [...ssh, 'sh -s'], { input: script, timeoutMs }),
        shSync: (script, timeoutMs) => spawnSync('ssh', [...ssh, 'sh -s'], {
            input: script,
            timeout: timeoutMs,
            encoding: 'utf8',
        }),
        async writeFile(file, data) {
            const result = await run('ssh', [...ssh, `cat > ${shellQuote(file)}`], { input: data });
            if (result.status !== 0) {
                throw new Error(`writing ${file} on ${alias} failed: ${lastLines(result.stderr) || result.status}`);
            }
        },
    };
}

/**
 * Runs named shell commands one after another in a single shell on the host, so that a step needs one round trip,
 * and returns each command's exit status and standard output by name, plus the standard error of the whole script.
 * Output outside the markers, such as text that shell startup files print, is ignored.
 */
export async function runCommands(host, commands, { cwd, timeoutMs } = {}) {
    const script = cwd ? [`cd ${shellQuote(cwd)} || exit 97`] : [];
    for (const [name, command] of Object.entries(commands)) {
        // The commands get no standard input: the rest of this script arrives there.
        script.push(`printf '\\n${MARK} begin %s\\n' ${name}`, `{ ${command}`, '} < /dev/null',
            `printf '\\n${MARK} end %s\\n' "$?"`);
    }
    const result = await host.sh(`${script.join('\n')}\n`, { timeoutMs });
    if (result.status === 97) {
        throw new Error(`${cwd} is missing on ${host.label}`);
    }
    const sections = { stderr: result.stderr };
    const pattern = new RegExp(`\\n${MARK} begin (\\S+)\\n([\\s\\S]*?)\\n${MARK} end (\\d+)\\n`, 'g');
    for (const [, name, out, status] of result.stdout.matchAll(pattern)) {
        sections[name] = { status: Number(status), out };
    }
    const missing = Object.keys(commands).filter(name => !sections[name]);
    if (missing.length > 0) {
        throw new Error(`${host.label} returned no result for ${missing.join(', ')} (exit code ${result.status}):`
            + ` ${lastLines(result.stderr) || 'no error output'}`);
    }
    return sections;
}

/**
 * Starts a user-level sshd on a free port of 127.0.0.1 that accepts one throwaway key, and writes an ssh
 * configuration whose host LOCAL_SSH_ALIAS reaches it. stop() or stopSync() ends it and deletes its files.
 */
export async function startLocalSshd() {
    const dir = await mkdtemp(path.join(tmpdir(), 'view-patch-sshd-'));
    const file = name => path.join(dir, name);
    const sshd = {
        alias: LOCAL_SSH_ALIAS,
        dir,
        configFile: file('ssh_config'),
        port: undefined,
        child: undefined,
        stop: () => stopSshd(sshd),
        stopSync: () => stopSshdSync(sshd),
    };
    try {
        await chmod(dir, 0o700);
        for (const key of ['host_key', 'client_key']) {
            const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `view-patch check A ${key}`,
                '-f', file(key)]);
            if (made.status !== 0) {
                throw new Error(`ssh-keygen failed: ${lastLines(made.stderr)}`);
            }
            await chmod(file(key), 0o600);
        }
        await writeFile(file('authorized_keys'), await readFile(file('client_key.pub')), { mode: 0o600 });
        const user = userInfo().username;
        for (let attempt = 1; sshd.port === undefined; attempt++) {
            const port = await freePort();
            await writeFile(file('sshd_config'), sshdConfig(dir, port, user), { mode: 0o600 });
            const test = await run(SSHD, ['-t', '-f', file('sshd_config')]).catch(error => {
                throw new Error(`${SSHD} cannot run: ${error.message}`);
            });
            if (test.status !== 0) {
                throw new Error(`sshd rejected its configuration: ${lastLines(test.stderr)}`);
            }
            const log = openSync(file('sshd.log'), 'a');
            // Its own process group, so that a Ctrl+C in the terminal reaches this script first, which then cleans up
            // over ssh before it stops sshd.
            sshd.child = spawn(SSHD, ['-D', '-e', '-f', file('sshd_config')], {
                detached: true,
                stdio: ['ignore', 'ignore', log],
            });
            closeSync(log);
            sshd.child.on('error', () => {});
            if (await listening(sshd.child, file('sshd.log'), port)) {
                sshd.port = port;
            } else {
                await stopChild(sshd.child);
                if (attempt === 3) {
                    throw new Error(`sshd did not start: ${lastLines(readFileSync(file('sshd.log'), 'utf8'))}`);
                }
            }
        }
        const [type, key] = (await readFile(file('host_key.pub'), 'utf8')).trim().split(/\s+/);
        await writeFile(file('known_hosts'), `[127.0.0.1]:${sshd.port} ${type} ${key}\n`, { mode: 0o600 });
        await writeFile(sshd.configFile, sshConfig(dir, sshd.port, user), { mode: 0o600 });
        return sshd;
    } catch (error) {
        await sshd.stop();
        throw error;
    }
}

function sshdConfig(dir, port, user) {
    const file = name => configValue(path.join(dir, name));
    return [
        '# A throwaway sshd for View Patch release check A, removed when the check ends.',
        'ListenAddress 127.0.0.1',
        `Port ${port}`,
        `HostKey ${file('host_key')}`,
        `PidFile ${file('sshd.pid')}`,
        `AuthorizedKeysFile ${tokens(file('authorized_keys'))}`,
        `AllowUsers ${user}`,
        'AuthenticationMethods publickey',
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        // The keys sit in a private folder, but its parents, such as /tmp, are shared, which StrictModes refuses.
        'StrictModes no',
        'PermitRootLogin no',
        // Otherwise sshd would run ~/.ssh/rc at each login.
        'PermitUserRC no',
        'PermitUserEnvironment no',
        // Remote - SSH reaches the VS Code Server through a local port forward.
        'AllowTcpForwarding local',
        'X11Forwarding no',
        'PrintMotd no',
        // The remote host is this computer, so its scratch folders go where this script's do.
        ...(process.env.TMPDIR ? [`SetEnv ${configValue(`TMPDIR=${tmpdir()}`)}`] : []),
        '',
    ].join('\n');
}

function sshConfig(dir, port, user) {
    const file = name => tokens(configValue(path.join(dir, name)));
    return [
        '# Client settings for the throwaway sshd of View Patch release check A, removed when the check ends.',
        `Host ${LOCAL_SSH_ALIAS}`,
        '    HostName 127.0.0.1',
        `    Port ${port}`,
        `    User ${user}`,
        `    IdentityFile ${file('client_key')}`,
        '    IdentitiesOnly yes',
        `    UserKnownHostsFile ${file('known_hosts')}`,
        '    GlobalKnownHostsFile /dev/null',
        '    StrictHostKeyChecking yes',
        '    UpdateHostKeys no',
        '    BatchMode yes',
        '    PreferredAuthentications publickey',
        '    ControlMaster no',
        '    ControlPath none',
        '    ConnectTimeout 15',
        '    LogLevel ERROR',
        '',
    ].join('\n');
}

/** Quotes a configuration value that holds spaces; ssh and sshd configurations have no escape for double quotes. */
function configValue(value) {
    if (value.includes('"')) {
        throw new Error(`ssh cannot be configured with a path that contains a double quote: ${value}`);
    }
    return /[\s#]/.test(value) ? `"${value}"` : value;
}

/** Escapes the % of ssh's tokens, such as %h, in a path. */
function tokens(value) {
    return value.replace(/%/g, '%%');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function listening(child, log, port) {
    const ready = `Server listening on 127.0.0.1 port ${port}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (readFileSync(log, 'utf8').includes(ready)) {
            return true;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            return false;
        }
        await delay(100);
    }
    return false;
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    if (!(await Promise.race([exited.then(() => true), delay(5000, false)]))) {
        child.kill('SIGKILL');
        await exited;
    }
}

async function stopSshd(sshd) {
    await stopChild(sshd.child);
    await rm(sshd.dir, { recursive: true, force: true });
}

function stopSshdSync(sshd) {
    if (sshd.child && sshd.child.exitCode === null && sshd.child.signalCode === null) {
        sshd.child.kill('SIGTERM');
    }
    rmSync(sshd.dir, { recursive: true, force: true });
}
