// The result format that the automated release checks share. A check records each step as it runs, then write()
// saves report.json and report.md in its output folder and appends the Markdown to the GitHub Actions step summary.
//
// A step passes, fails, passes through a substitute (an equivalent run where the step as written cannot run), or
// does not run. The verdict is fail when any step failed, incomplete when any step did not run, and otherwise pass,
// noting how many steps used a substitute; the release runbook decides which substitutes a campaign accepts.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STATUS_TEXT = Object.freeze({
    pass: 'PASS',
    fail: 'FAIL',
    substitute: 'PASS (substitute)',
    'not run': 'NOT RUN',
});

/** Process exit codes: 0 pass, 1 a step failed, 2 the check could not start (bad arguments), 3 incomplete. */
export const EXIT = Object.freeze({ pass: 0, fail: 1, usage: 2, incomplete: 3 });

const EVIDENCE_LIMIT = 6000;

export function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}

export class CheckReport {
    /**
     * @param {{ check: string, title: string, target?: Record<string, string> }} options `target` holds the
     *     identities the run tested, such as the extension version and the editor, in display order.
     */
    constructor({ check, title, target = {} }) {
        this.check = check;
        this.title = title;
        this.target = { ...target };
        this.startedAt = new Date().toISOString();
        this.finishedAt = undefined;
        this.steps = [];
        this.notes = [];
        this.evidence = [];
    }

    pass(id, name, detail) {
        return this.#add(id, name, 'pass', detail);
    }

    fail(id, name, detail) {
        return this.#add(id, name, 'fail', detail);
    }

    substitute(id, name, detail) {
        return this.#add(id, name, 'substitute', detail);
    }

    notRun(id, name, reason) {
        return this.#add(id, name, 'not run', reason);
    }

    /**
     * Runs one step. `task` returns the observation to record, or throws to fail the step with its message.
     * Returns whether the step passed.
     */
    async run(id, name, task, { substitute = false } = {}) {
        try {
            const detail = await task();
            this.#add(id, name, substitute ? 'substitute' : 'pass', detail);
            return true;
        } catch (error) {
            this.fail(id, name, errorText(error));
            return false;
        }
    }

    note(text) {
        this.notes.push(String(text));
    }

    /** Text kept with the report, such as copied diagnostics or the extension's log. */
    attach(label, text) {
        this.evidence.push({ label: String(label), text: String(text ?? '') });
    }

    get failed() {
        return this.steps.some(step => step.status === 'fail');
    }

    verdict() {
        const count = status => this.steps.filter(step => step.status === status).length;
        if (count('fail') > 0) {
            return { verdict: 'fail', exitCode: EXIT.fail, text: `FAIL (${plural(count('fail'), 'step')} failed)` };
        }
        if (this.steps.length === 0 || count('not run') > 0) {
            const why = this.steps.length === 0 ? 'no step ran' : `${plural(count('not run'), 'step')} not run`;
            return { verdict: 'incomplete', exitCode: EXIT.incomplete, text: `INCOMPLETE (${why})` };
        }
        const substitutes = count('substitute');
        return {
            verdict: substitutes > 0 ? 'pass with substitutes' : 'pass',
            exitCode: EXIT.pass,
            text: substitutes > 0 ? `PASS (${plural(substitutes, 'step')} through a substitute)` : 'PASS',
        };
    }

    toJSON() {
        const { verdict } = this.verdict();
        return {
            schemaVersion: 1,
            check: this.check,
            title: this.title,
            verdict,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            target: this.target,
            steps: this.steps,
            notes: this.notes,
            evidence: this.evidence,
        };
    }

    toMarkdown() {
        const { text } = this.verdict();
        const lines = [`### ${this.title}: ${text}`, ''];
        const target = Object.entries(this.target).map(([label, value]) => `${label}: ${value}`);
        const times = this.finishedAt ? `${this.startedAt} to ${this.finishedAt}` : `started ${this.startedAt}`;
        lines.push([...target, times].join(' · '), '', '| Step | Result | Observation |', '| --- | --- | --- |');
        for (const step of this.steps) {
            lines.push(`| ${cell(`${step.id}. ${step.name}`)} | ${STATUS_TEXT[step.status]} | ${cell(step.detail)} |`);
        }
        lines.push('');
        for (const note of this.notes) {
            lines.push(`- ${note.replace(/\r?\n/g, ' ')}`);
        }
        if (this.notes.length > 0) {
            lines.push('');
        }
        for (const { label, text: body } of this.evidence) {
            const shown = body.length > EVIDENCE_LIMIT
                ? `${body.slice(0, EVIDENCE_LIMIT)}\n[${body.length - EVIDENCE_LIMIT} more characters in report.json]`
                : body;
            const fence = '`'.repeat(Math.max(3, ...[...shown.matchAll(/`+/g)].map(match => match[0].length + 1)));
            lines.push(`<details><summary>${escapeHtml(label)}</summary>`, '', `${fence}text`, shown, fence, '',
                '</details>', '');
        }
        return `${lines.join('\n')}\n`;
    }

    /** Finishes the report, writes it to `outDir`, appends the step summary, and returns the exit code. */
    write(outDir) {
        this.finishedAt = new Date().toISOString();
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(this, null, 2)}\n`);
        const markdown = this.toMarkdown();
        writeFileSync(path.join(outDir, 'report.md'), markdown);
        if (process.env.GITHUB_STEP_SUMMARY) {
            appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
        }
        const { text, exitCode } = this.verdict();
        for (const step of this.steps) {
            console.log(`${STATUS_TEXT[step.status].padEnd(17)} ${step.id}. ${step.name}: ${step.detail}`);
        }
        console.log(`${this.title}: ${text}. Report: ${path.join(outDir, 'report.md')}`);
        return exitCode;
    }

    #add(id, name, status, detail) {
        const step = { id: String(id), name: String(name), status, detail: String(detail ?? '') };
        this.steps.push(step);
        return step;
    }
}

function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function cell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
