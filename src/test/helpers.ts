import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Keep the tests, and the code they run, independent of this machine's Git settings and identity.
const configHome = mkdtempSync(path.join(os.tmpdir(), 'view-patch-config-'));
writeFileSync(path.join(configHome, 'gitconfig'), '');
for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(name)) {
        delete process.env[name];
    }
}
Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(configHome, 'gitconfig'),
    GIT_AUTHOR_NAME: 'View Patch Tests',
    GIT_AUTHOR_EMAIL: 'tests@example.com',
    GIT_COMMITTER_NAME: 'View Patch Tests',
    GIT_COMMITTER_EMAIL: 'tests@example.com',
});

/** File contents by relative path; null deletes the file. */
export type Files = Record<string, string | Buffer | null>;

const made: string[] = [configHome];

/** Runs Git in `cwd` and returns its standard output. */
export function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A new empty folder, deleted by removeTempDirs. */
export function tempDir(prefix = 'view-patch-test-'): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(dir);
    return dir;
}

export function removeTempDirs(): void {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
}

export function writeFiles(root: string, files: Files): void {
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        if (content === null) {
            rmSync(file, { force: true });
        } else {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, content);
        }
    }
}

/** A new repository whose first commit holds `files`. */
export function makeRepo(files: Files): string {
    const repo = tempDir('view-patch-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFiles(repo, files);
    commitAll(repo, 'First commit');
    return repo;
}

/** Stages everything, ignored files included, commits it, and returns the new commit. */
export function commitAll(repo: string, message: string): string {
    git(repo, 'add', '-A', '-f');
    git(repo, 'commit', '-q', '--allow-empty', '-m', message);
    return git(repo, 'rev-parse', 'HEAD').trim();
}

/** The `git format-patch` text of one commit. */
export function formatPatch(repo: string, revision = 'HEAD'): string {
    return git(repo, 'format-patch', '-1', '--stdout', '--binary', '-M', revision);
}

/** A path in a form that compares equal however the folder was reached. */
export function canonical(folder: string): string {
    const real = realpathSync.native(folder);
    return process.platform === 'win32' ? real.toLowerCase() : real;
}
