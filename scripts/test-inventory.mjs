// Counts the tests that each test layer defines by scanning the test sources, without running them.
//
//   node scripts/test-inventory.mjs           per-layer and per-file counts
//   node scripts/test-inventory.mjs --list    the same, with every test title
//   node scripts/test-inventory.mjs --check   exit 1 when TEST_PLAN.md disagrees with the sources
//
// A test defined inside `for (const x of [...])` counts once per array element, as the runners count it. The
// iterable must be an array literal or a `const` array declared earlier in the file. A test definition in any
// other context, such as a helper function, a conditional, or a computed iterable, is reported as a problem
// instead of being guessed. --check also confirms that each test title quoted in the plan's traceability table
// is still defined in the file that its row cites.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLAN_FILE = 'TEST_PLAN.md';

// Each pattern mirrors what the layer's runner loads: the compiled **/*.test.js globs in package.json and
// .vscode-test.mjs, the run.js that scripts/test-restricted.mjs launches, and the suite esbuild.webtest.mjs bundles.
export const LAYERS = [
    { id: 'unit', dir: 'src/test/unit', pattern: /\.test\.ts$/, kind: 'tests', runner: 'node:test' },
    { id: 'editor', dir: 'src/test/integration', pattern: /\.test\.ts$/, kind: 'tests', runner: 'Mocha in VS Code' },
    { id: 'restricted', dir: 'src/test/restricted', pattern: /^run\.ts$/, kind: 'scenarios', runner: 'isolated VS Code' },
    { id: 'web', dir: 'src/test/web', pattern: /^suite\.test\.ts$/, kind: 'tests', runner: 'Mocha in Chromium' },
];

const TEST_CALLS = new Set(['test', 'it']);
const SUITE_CALLS = new Set(['suite', 'describe']);
const MODIFIERS = new Set(['skip', 'only', 'todo']);
// After these keywords a slash starts a regular expression rather than a division.
const EXPRESSION_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield',
    'await',
]);
const OPENERS = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUMBER = /\.?\d[\w.]*/y;

const isPunct = (token, value) => token !== undefined && token.type === 'punct' && token.value === value;
const isWord = (token, value) => token !== undefined && token.type === 'word' && token.value === value;
const isOpener = token => token !== undefined && token.type === 'punct' && OPENERS.has(token.value);

/** Splits TypeScript source into words, strings, templates, regular expressions, numbers, and punctuation. */
export function tokenize(source) {
    const lineStarts = [0];
    for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) {
        lineStarts.push(i + 1);
    }
    const lineOf = offset => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (lineStarts[middle] <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return low + 1;
    };
    const fail = (message, offset) => {
        throw new SyntaxError(`${message} on line ${lineOf(offset)}`);
    };

    const skipQuoted = (start, quote) => {
        for (let i = start + 1; i < source.length; i++) {
            if (source[i] === '\\') {
                i++;
            } else if (source[i] === quote) {
                return i + 1;
            } else if (source[i] === '\n') {
                break;
            }
        }
        return fail('Unterminated string', start);
    };

    // Returns the end of a regular expression literal, or -1 when the slash cannot start one.
    const skipRegex = start => {
        let inClass = false;
        for (let i = start + 1; i < source.length; i++) {
            const c = source[i];
            if (c === '\n' || c === '\r') {
                return -1;
            } else if (c === '\\') {
                i++;
            } else if (inClass) {
                inClass = c !== ']';
            } else if (c === '[') {
                inClass = true;
            } else if (c === '/') {
                let end = i + 1;
                while (end < source.length && /[a-z]/i.test(source[end])) {
                    end++;
                }
                return end;
            }
        }
        return -1;
    };

    const skipTemplate = start => {
        for (let i = start + 1; i < source.length; i++) {
            if (source[i] === '\\') {
                i++;
            } else if (source[i] === '`') {
                return i + 1;
            } else if (source[i] === '$' && source[i + 1] === '{') {
                i = scan(i + 2, true).end - 1;
            }
        }
        return fail('Unterminated template literal', start);
    };

    // Scans tokens from `start`; inside a template substitution it stops after the closing brace.
    function scan(start, substitution) {
        const tokens = [];
        let depth = 0;
        let i = start;
        const push = (type, end, value = source.slice(i, end)) => {
            tokens.push({ type, value, start: i, end, line: lineOf(i) });
            i = end;
        };
        while (i < source.length) {
            const c = source[i];
            if (/\s/.test(c) || c === '\uFEFF') {
                i++;
            } else if (source.startsWith('//', i) || (i === 0 && source.startsWith('#!'))) {
                const newline = source.indexOf('\n', i);
                i = newline < 0 ? source.length : newline + 1;
            } else if (source.startsWith('/*', i)) {
                const close = source.indexOf('*/', i + 2);
                if (close < 0) {
                    fail('Unterminated comment', i);
                }
                i = close + 2;
            } else if (c === "'" || c === '"') {
                const end = skipQuoted(i, c);
                push('string', end, decodeString(source.slice(i + 1, end - 1)));
            } else if (c === '`') {
                const end = skipTemplate(i);
                push('template', end, source.slice(i + 1, end - 1));
            } else if (c === '/' && regexMayFollow(tokens.at(-1)) && skipRegex(i) > 0) {
                push('regex', skipRegex(i));
            } else if ((IDENTIFIER.lastIndex = i, IDENTIFIER.test(source))) {
                push('word', IDENTIFIER.lastIndex);
            } else if ((NUMBER.lastIndex = i, NUMBER.test(source))) {
                push('number', NUMBER.lastIndex);
            } else if (source.startsWith('...', i) || source.startsWith('=>', i)) {
                push('punct', i + (c === '.' ? 3 : 2));
            } else {
                if (substitution && c === '{') {
                    depth++;
                } else if (substitution && c === '}' && depth-- === 0) {
                    return { tokens, end: i + 1 };
                }
                push('punct', i + 1);
            }
        }
        if (substitution) {
            fail('Unterminated template substitution', start);
        }
        return { tokens, end: i };
    }

    return scan(0, false).tokens;
}

function regexMayFollow(previous) {
    if (previous === undefined) {
        return true;
    }
    if (previous.type === 'punct') {
        return previous.value !== ')' && previous.value !== ']';
    }
    return previous.type === 'word' && EXPRESSION_KEYWORDS.has(previous.value);
}

function decodeString(body) {
    return body.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g, (_, escape) => {
        if (escape[0] === 'u' || escape[0] === 'x') {
            return String.fromCodePoint(parseInt(escape.replace(/[ux{}]/g, ''), 16));
        }
        return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '', '\r\n': '' }[escape] ?? escape;
    });
}

/** Maps each bracket token's index to its partner's index. */
function pairBrackets(tokens) {
    const partner = new Array(tokens.length).fill(-1);
    const open = [];
    tokens.forEach((token, index) => {
        if (token.type !== 'punct') {
            return;
        }
        if (OPENERS.has(token.value)) {
            open.push(index);
        } else if (token.value === ')' || token.value === ']' || token.value === '}') {
            const opener = open.pop();
            if (opener === undefined || OPENERS.get(tokens[opener].value) !== token.value) {
                throw new SyntaxError(`Unbalanced '${token.value}' on line ${token.line}`);
            }
            partner[opener] = index;
            partner[index] = opener;
        }
    });
    if (open.length > 0) {
        throw new SyntaxError(`Unclosed '${tokens[open[0]].value}' on line ${tokens[open[0]].line}`);
    }
    return partner;
}

/** Inventories one test source: its tests and suites, or for the restricted layer its scenarios. */
export function scanSource(source, kind = 'tests') {
    const tokens = tokenize(source);
    const partner = pairBrackets(tokens);
    if (kind === 'scenarios') {
        return scanScenarios(tokens);
    }
    const tests = [];
    const suites = [];
    const problems = [];
    const enclosing = [];
    tokens.forEach((token, index) => {
        if (isOpener(token)) {
            enclosing.push(index);
            return;
        }
        if (token.type === 'punct' && partner[index] >= 0) {
            enclosing.pop();
            return;
        }
        const call = callAt(tokens, index, TEST_CALLS) ?? callAt(tokens, index, SUITE_CALLS);
        if (call === undefined) {
            return;
        }
        const context = contextOf(source, tokens, partner, enclosing, index);
        const entry = {
            title: argumentTitle(source, tokens, partner, call.paren),
            line: token.line,
            modifier: call.modifier,
            multiplier: context.multiplier,
            suites: context.suites,
        };
        if (context.problem !== undefined) {
            problems.push({ line: token.line, message: context.problem });
        }
        (TEST_CALLS.has(token.value) ? tests : suites).push(entry);
    });
    return { tests, suites, problems, count: total(tests), suiteCount: total(suites) };
}

const total = entries => entries.reduce((sum, entry) => sum + entry.multiplier, 0);

// The restricted layer is one scripted editor session; each `console.log('PASS: ...')` marks one scenario.
function scanScenarios(tokens) {
    const tests = [];
    tokens.forEach((token, index) => {
        if (isWord(token, 'console') && isPunct(tokens[index + 1], '.') && isWord(tokens[index + 2], 'log')
            && isPunct(tokens[index + 3], '(') && tokens[index + 4]?.type === 'string'
            && tokens[index + 4].value.startsWith('PASS: ')) {
            tests.push({ title: tokens[index + 4].value.slice(6), line: token.line, multiplier: 1, suites: [] });
        }
    });
    return { tests, suites: [], problems: [], count: tests.length, suiteCount: 0 };
}

// A call such as test(...), test.skip(...), or suite(...); member calls like regex.test(...) do not count.
function callAt(tokens, index, names) {
    const token = tokens[index];
    if (token.type !== 'word' || !names.has(token.value) || isPunct(tokens[index - 1], '.')
        || isWord(tokens[index - 1], 'function')) {
        return undefined;
    }
    let paren = index + 1;
    let modifier;
    if (isPunct(tokens[paren], '.') && tokens[paren + 1]?.type === 'word' && MODIFIERS.has(tokens[paren + 1].value)) {
        modifier = tokens[paren + 1].value;
        paren += 2;
    }
    return isPunct(tokens[paren], '(') ? { paren, modifier } : undefined;
}

function suiteCallOpening(tokens, paren) {
    let index = paren - 1;
    if (tokens[index]?.type === 'word' && MODIFIERS.has(tokens[index].value) && isPunct(tokens[index - 1], '.')) {
        index -= 2;
    }
    return callAt(tokens, index, SUITE_CALLS)?.paren === paren;
}

function isFunctionBody(tokens, partner, brace) {
    const before = tokens[brace - 1];
    if (isPunct(before, '=>')) {
        return true;
    }
    if (!isPunct(before, ')')) {
        return false;
    }
    const opener = partner[brace - 1];
    return isWord(tokens[opener - 1], 'function')
        || (tokens[opener - 1]?.type === 'word' && isWord(tokens[opener - 2], 'function'));
}

// Decides how many times the code at `index` runs per suite registration, or why that cannot be known.
function contextOf(source, tokens, partner, enclosing, index) {
    let multiplier = 1;
    const suites = [];
    for (let level = 0; level < enclosing.length; level++) {
        const opener = enclosing[level];
        if (suiteCallOpening(tokens, opener)) {
            suites.push(argumentTitle(source, tokens, partner, opener));
            continue;
        }
        if (tokens[opener].value === '{') {
            if (level > 0 && suiteCallOpening(tokens, enclosing[level - 1]) && isFunctionBody(tokens, partner, opener)) {
                continue;
            }
            const loop = isPunct(tokens[opener - 1], ')') ? forOfLoop(tokens, partner, opener - 1) : undefined;
            if (loop?.count !== undefined) {
                multiplier *= loop.count;
                continue;
            }
            return { multiplier, suites, problem: loop?.problem ?? 'defined inside a block that is not a suite or a loop' };
        }
        return { multiplier, suites, problem: `defined inside '${tokens[opener].value}' on line ${tokens[opener].line}` };
    }
    // Loops without braces: for (const x of [...]) test(...)
    for (let start = index; isPunct(tokens[start - 1], ')');) {
        const loop = forOfLoop(tokens, partner, start - 1);
        if (loop === undefined) {
            break;
        }
        if (loop.count === undefined) {
            return { multiplier, suites, problem: loop.problem };
        }
        multiplier *= loop.count;
        start = loop.forIndex;
    }
    return { multiplier, suites };
}

// Describes the loop whose header ends at `close`, or returns undefined when that is not a for-loop header.
function forOfLoop(tokens, partner, close) {
    const opener = partner[close];
    let forIndex = opener - 1;
    if (isWord(tokens[forIndex], 'await')) {
        forIndex--;
    }
    if (!isWord(tokens[forIndex], 'for')) {
        return undefined;
    }
    const line = tokens[forIndex].line;
    let of = -1;
    for (let i = opener + 1; i < close && of < 0; i++) {
        if (isOpener(tokens[i])) {
            i = partner[i];
        } else if (isWord(tokens[i], 'of')) {
            of = i;
        }
    }
    if (of < 0) {
        return { forIndex, problem: `the loop on line ${line} is not a for...of loop over an array` };
    }
    const count = arrayLength(tokens, partner, of + 1, close, forIndex);
    return count === undefined
        ? { forIndex, problem: `the loop on line ${line} does not iterate over an array literal or a const array` }
        : { forIndex, count };
}

// The element count of the array that tokens[first, end) evaluate to, when that is statically evident.
function arrayLength(tokens, partner, first, end, before) {
    if (isWord(tokens[end - 1], 'const') && isWord(tokens[end - 2], 'as')) {
        end -= 2;
    }
    if (isPunct(tokens[first], '[') && partner[first] === end - 1) {
        return countElements(tokens, partner, first);
    }
    if (end - first !== 1 || tokens[first].type !== 'word') {
        return undefined;
    }
    const name = tokens[first].value;
    for (let i = before - 1; i > 0; i--) {
        if (tokens[i].type === 'word' && tokens[i].value === name && isWord(tokens[i - 1], 'const')) {
            let value = i + 1;
            if (isPunct(tokens[value], ':')) {
                while (value < tokens.length && !isPunct(tokens[value], '=')) {
                    value = isOpener(tokens[value]) ? partner[value] + 1 : value + 1;
                }
            }
            return isPunct(tokens[value], '=') && isPunct(tokens[value + 1], '[')
                ? countElements(tokens, partner, value + 1)
                : undefined;
        }
    }
    return undefined;
}

function countElements(tokens, partner, opener) {
    const close = partner[opener];
    if (close === opener + 1) {
        return 0;
    }
    let count = 1;
    for (let i = opener + 1; i < close; i++) {
        if (isOpener(tokens[i])) {
            i = partner[i];
        } else if (isPunct(tokens[i], '...')) {
            return undefined;
        } else if (isPunct(tokens[i], ',')) {
            count++;
        }
    }
    return isPunct(tokens[close - 1], ',') ? count - 1 : count;
}

// The first argument of a call as written: a string's value, a template's text, or the source of an expression.
function argumentTitle(source, tokens, partner, paren) {
    const close = partner[paren];
    let last = paren + 1;
    while (last < close && !isPunct(tokens[last], ',')) {
        last = isOpener(tokens[last]) ? partner[last] + 1 : last + 1;
    }
    const first = tokens[paren + 1];
    if (last === paren + 2 && (first.type === 'string' || first.type === 'template')) {
        return first.value;
    }
    return last === paren + 1 ? '' : `<${source.slice(first.start, tokens[last - 1].end)}>`;
}

/** Scans every layer's sources under `base`. */
export function scanRepository(base = root) {
    return LAYERS.map(layer => {
        const folder = path.join(base, layer.dir);
        const files = readdirSync(folder, { recursive: true })
            .map(name => name.split(path.sep).join('/'))
            .filter(name => layer.pattern.test(path.posix.basename(name)))
            .sort()
            .map(name => {
                const file = `${layer.dir}/${name}`;
                try {
                    return { file, ...scanSource(readFileSync(path.join(folder, name), 'utf8'), layer.kind) };
                } catch (error) {
                    return { file, tests: [], suites: [], count: 0, suiteCount: 0, problems: [{ line: 0, message: error.message }] };
                }
            });
        return {
            ...layer,
            files,
            count: files.reduce((sum, file) => sum + file.count, 0),
            suiteCount: files.reduce((sum, file) => sum + file.suiteCount, 0),
        };
    });
}

/** Extracts the per-layer counts from the plan's marked inventory table. */
export function plannedCounts(markdown) {
    const block = markedBlock(markdown, 'test-inventory');
    if (block === undefined) {
        return undefined;
    }
    const counts = new Map();
    for (const cells of tableRows(block)) {
        const count = Number(cells.at(-1));
        if (Number.isInteger(count)) {
            counts.set(cells[0].replace(/`/g, ''), count);
        }
    }
    return counts;
}

/** The (file, title) citations in the plan's marked traceability table. */
export function citedTests(markdown) {
    const block = markedBlock(markdown, 'traceability');
    if (block === undefined) {
        return undefined;
    }
    const citations = [];
    for (const cells of tableRows(block)) {
        const files = [...cells.join(' ').matchAll(/`(src\/test\/[^`]+\.ts)`/g)].map(match => match[1]);
        const titles = [...cells.at(-1).matchAll(/"([^"]+)"/g)].map(match => match[1]);
        for (const title of titles) {
            citations.push({ files, title });
        }
    }
    return citations;
}

function markedBlock(markdown, name) {
    const match = markdown.match(new RegExp(`<!-- ${name}:begin -->([\\s\\S]*?)<!-- ${name}:end -->`));
    return match?.[1];
}

function tableRows(block) {
    return block.split(/\r?\n/)
        .filter(line => line.trim().startsWith('|') && !/^\|[\s|:-]+\|$/.test(line.trim()))
        .map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))
        .slice(1);
}

/** Compares the plan with a repository scan; returns human-readable failures, empty when they agree. */
export function checkPlan(markdown, layers) {
    const failures = [];
    for (const layer of layers) {
        for (const file of layer.files) {
            for (const problem of file.problems) {
                failures.push(`${file.file}:${problem.line}: cannot count statically: ${problem.message}. Define the `
                    + 'test directly in a suite, or loop over an array literal or a const array.');
            }
        }
    }
    const planned = plannedCounts(markdown);
    if (planned === undefined) {
        return [...failures, `${PLAN_FILE} has no <!-- test-inventory:begin --> ... <!-- test-inventory:end --> table.`];
    }
    for (const layer of layers) {
        const stated = planned.get(layer.id);
        if (stated === undefined) {
            failures.push(`${PLAN_FILE} does not state a count for the ${layer.id} layer.`);
        } else if (stated !== layer.count) {
            failures.push(`${PLAN_FILE} states ${stated} ${layer.kind} for the ${layer.id} layer, but ${layer.dir} defines `
                + `${layer.count}. Update the inventory table; run node scripts/test-inventory.mjs --list to see them.`);
        }
    }
    for (const id of planned.keys()) {
        if (!layers.some(layer => layer.id === id)) {
            failures.push(`${PLAN_FILE} states a count for an unknown layer '${id}'.`);
        }
    }
    const byFile = new Map(layers.flatMap(layer => layer.files.map(file => [file.file, file])));
    for (const { files, title } of citedTests(markdown) ?? []) {
        const known = files.filter(file => byFile.has(file));
        if (known.length === 0) {
            failures.push(`${PLAN_FILE} cites "${title}" without a test file that exists.`);
        } else if (!known.some(file => byFile.get(file).tests.some(test => test.title === title))) {
            failures.push(`${PLAN_FILE} cites "${title}", which ${known.join(' or ')} no longer defines.`);
        }
    }
    return failures;
}

function plural(count, noun) {
    return `${count} ${count === 1 ? noun.replace(/s$/, '') : noun}`;
}

function report(layers, list) {
    const lines = ['Test inventory, counted statically from the test sources:'];
    for (const layer of layers) {
        const suites = layer.suiteCount > 0 ? `, ${plural(layer.suiteCount, 'suites')}` : '';
        lines.push(`  ${layer.id.padEnd(11)}${plural(layer.count, layer.kind).padStart(14)}${suites} in `
            + `${plural(layer.files.length, 'files')} (${layer.runner})`);
    }
    for (const layer of layers) {
        lines.push('', `${layer.id} (${layer.dir}):`);
        for (const file of layer.files) {
            lines.push(`  ${String(file.count).padStart(4)}  ${file.file}`);
            if (!list) {
                continue;
            }
            for (const test of file.tests) {
                const times = test.multiplier === 1 ? '' : ` [x${test.multiplier}]`;
                const modifier = test.modifier ? ` [${test.modifier}]` : '';
                lines.push(`          ${[...test.suites, test.title].join(' > ')}${times}${modifier}`);
            }
        }
    }
    return lines.join('\n');
}

function main(args) {
    const unknown = args.filter(arg => arg !== '--list' && arg !== '--check');
    if (unknown.length > 0) {
        console.error(`Unknown option ${unknown[0]}. Usage: node scripts/test-inventory.mjs [--list] [--check]`);
        return 2;
    }
    const layers = scanRepository();
    if (!args.includes('--check')) {
        console.log(report(layers, args.includes('--list')));
        return layers.some(layer => layer.files.some(file => file.problems.length > 0)) ? 1 : 0;
    }
    if (args.includes('--list')) {
        console.log(report(layers, true));
    }
    const failures = checkPlan(readFileSync(path.join(root, PLAN_FILE), 'utf8'), layers);
    if (failures.length > 0) {
        console.error(`Test inventory drift:\n${failures.map(failure => `  - ${failure}`).join('\n')}`);
        return 1;
    }
    const summary = layers.map(layer => `${layer.id} ${layer.count}`).join(', ');
    console.log(`${PLAN_FILE} matches the test sources: ${summary}.`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
