// Where the extension host runs, for the Patch Reviews title and View Patch: Show Environment. It imports neither
// vscode nor Node.js modules, so both the web bundle and the unit tests can load it.

export interface HostFacts {
    /** False in VS Code for the Web, whose extension host has no Node.js and so cannot run Git. */
    readonly runsNode: boolean;
    readonly platform?: string;
    /** `vscode.env.remoteName`, set in a remote window, such as `ssh-remote` or `wsl`. */
    readonly remoteName?: string;
}

export interface HostSummary {
    /** For the view title, such as `remote Linux`. */
    readonly short: string;
    /** Completes "View Patch <version> is running ...". */
    readonly where: string;
}

const PLATFORMS = new Map([['darwin', 'macOS'], ['linux', 'Linux'], ['win32', 'Windows']]);

export function hostSummary(facts: HostFacts): HostSummary {
    if (!facts.runsNode) {
        return { short: 'browser', where: 'in the browser, which cannot run Git, so patches open as hunks only' };
    }
    const platform = PLATFORMS.get(facts.platform ?? '') ?? facts.platform ?? 'unknown';
    return facts.remoteName
        ? { short: `remote ${platform}`, where: `on a remote ${platform} host (${facts.remoteName})` }
        : { short: `local ${platform}`, where: `on this computer (${platform})` };
}
