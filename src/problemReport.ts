// Builds the text a user may choose to share in a bug report. Free of the vscode API and Node built-ins,
// so it runs unchanged in unit tests and in VS Code for the Web.

export const ISSUE_FORM_URL = 'https://github.com/waddahmoghram/vscode-view-patch/issues/new?template=bug_report.yml';

/** Folders whose paths shared text must not reveal. */
export interface PrivateFolders {
    /** Shown as `~`. */
    readonly home?: string;
    /** Each shown as `<workspace>`. */
    readonly workspaces?: readonly string[];
}

/**
 * Replaces private folder paths in text meant for sharing. A Windows path (drive letter or `\\server\share`)
 * matches case-insensitively and with either slash; a POSIX path matches case-sensitively. A folder matches only
 * as whole path segments, so a home of `/home/al` leaves `/home/alice` alone. When folders nest, the longest wins.
 */
export function redactPaths(text: string, folders: PrivateFolders): string {
    const replacements = [
        ...(folders.workspaces ?? []).map(folder => ({ folder, label: '<workspace>' })),
        ...(folders.home === undefined ? [] : [{ folder: folders.home, label: '~' }]),
    ].flatMap(({ folder, label }) => {
        const pattern = folderPattern(folder);
        return pattern ? [{ ...pattern, label }] : [];
    }).sort((a, b) => b.length - a.length);
    let result = text;
    for (const { regex, label } of replacements) {
        result = result.replace(regex, () => label);
    }
    return result;
}

/** The redacted diagnostics framed for an issue, stating what was left out. */
export function problemReport(diagnostics: string): string {
    return [
        'View Patch problem report',
        '',
        diagnostics.trimEnd(),
        '',
        'Not included: patch content, clipboard content, repository paths, Git arguments,'
            + ' and the View Patch output log.',
        'The home folder is shown as ~ and workspace folders as <workspace>.',
        'Optional: if the problem needs a patch to reproduce, you may add a minimal neutral one to the issue,',
        'with no proprietary code, private paths, or credentials.',
    ].join('\n') + '\n';
}

function folderPattern(folder: string): { readonly regex: RegExp; readonly length: number } | undefined {
    const windows = /^[A-Za-z]:(?:[\\/]|$)|^\\\\/.test(folder);
    const parts = folder.split(windows ? /[\\/]+/ : /\/+/);
    while (parts.length && parts[parts.length - 1] === '') {
        parts.pop();
    }
    // A bare root such as '/', 'C:\', or '\\server' would redact every path.
    if (parts.filter(Boolean).length < (windows ? 2 : 1)) {
        return undefined;
    }
    const body = parts.map(part => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join(windows ? '[\\\\/]+' : '/+');
    // The folder must end at a segment boundary; a trailing period is punctuation, not part of a name.
    const regex = new RegExp(`${body}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])`, windows ? 'giu' : 'gu');
    return { regex, length: parts.join('/').length };
}
