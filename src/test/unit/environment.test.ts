import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostSummary } from '../../environment';

test('names the browser, this computer, or a remote host so the window in use is clear', () => {
    assert.deepStrictEqual(hostSummary({ runsNode: false, remoteName: 'ssh-remote' }), {
        short: 'browser', where: 'in the browser, which cannot run Git, so patches open as hunks only',
    });
    assert.deepStrictEqual(hostSummary({ runsNode: true, platform: 'win32' }), {
        short: 'local Windows', where: 'on this computer (Windows)',
    });
    assert.deepStrictEqual(hostSummary({ runsNode: true, platform: 'linux', remoteName: 'ssh-remote' }), {
        short: 'remote Linux', where: 'on a remote Linux host (ssh-remote)',
    });
    assert.strictEqual(hostSummary({ runsNode: true, platform: 'darwin' }).short, 'local macOS');
    assert.strictEqual(hostSummary({ runsNode: true, platform: 'freebsd' }).short, 'local freebsd');
});
