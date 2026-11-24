import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactPaths } from '../../problemReport';

test('shows a POSIX home folder as ~ wherever a path starts with it', () => {
    assert.strictEqual(
        redactPaths('Git executable: /home/al/bin/git\nspawn /home/al ENOENT; cwd /home/al.', { home: '/home/al/' }),
        'Git executable: ~/bin/git\nspawn ~ ENOENT; cwd ~.');
});

test('matches a Windows home case-insensitively with either slash', () => {
    assert.strictEqual(
        redactPaths('c:/users/alice/bin/git.exe; C:\\USERS\\Alice\\scoop\\git.exe', { home: 'C:\\Users\\Alice' }),
        '~/bin/git.exe; ~\\scoop\\git.exe');
});

test('shows a workspace folder as <workspace>, even inside the home folder', () => {
    assert.strictEqual(
        redactPaths('/home/al/project/tools/git and /home/al/other', {
            home: '/home/al', workspaces: ['/home/al/project'],
        }),
        '<workspace>/tools/git and ~/other');
});

test('leaves text unchanged when it holds no private folder', () => {
    const text = 'Git executable: /usr/bin/git\nWorkspace folders: 0; trusted: true\n';
    assert.strictEqual(redactPaths(text, { home: '/home/al', workspaces: ['/srv/project'] }), text);
    assert.strictEqual(redactPaths(text, {}), text);
    assert.strictEqual(redactPaths(text, { home: '/' }), text, 'a bare root must not redact every path');
});

test('does not redact a folder that only prefixes another folder name', () => {
    const posix = 'Git executable: /home/alice/bin/git; /home/al-old; /home/al.bak';
    assert.strictEqual(redactPaths(posix, { home: '/home/al' }), posix);
    const windows = 'Git executable: C:\\Users\\Alice\\bin\\git.exe';
    assert.strictEqual(redactPaths(windows, { home: 'c:/users/al' }), windows);
});
