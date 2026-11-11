import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Entry {
    title: string;
    line: number;
    modifier?: string;
    multiplier: number;
    suites: string[];
}

interface SourceInventory {
    tests: Entry[];
    suites: Entry[];
    problems: { line: number; message: string }[];
    count: number;
    suiteCount: number;
}

interface Layer {
    id: string;
    dir: string;
    kind: string;
    files: (SourceInventory & { file: string })[];
    count: number;
}

interface Inventory {
    scanSource(source: string, kind?: string): SourceInventory;
    checkPlan(markdown: string, layers: Layer[]): string[];
}

const script = path.join(__dirname, '..', '..', '..', 'scripts', 'test-inventory.mjs');
const load = (): Promise<Inventory> => import(pathToFileURL(script).href);

describe('test inventory scan', () => {
    test('counts a looped test once per element of an inline or const array', async () => {
        const { scanSource } = await load();
        const inventory = scanSource([
            "const cases: readonly [string, RegExp][] = [['a', /x\\//], ['b', /[/]/], ['c', /,/]];",
            "describe('parser', () => {",
            '    for (const [name] of cases) {',
            '        test(`rejects ${name}`, () => {});',
            '    }',
            "    for (const n of [1, 2,] as const) test('limit ' + n, () => {});",
            "    test('plain', () => {});",
            '});',
        ].join('\n'));
        assert.deepEqual(inventory.problems, []);
        assert.equal(inventory.count, 6);
        assert.equal(inventory.suiteCount, 1);
        assert.deepEqual(inventory.tests.map(entry => [entry.title, entry.multiplier, entry.line]), [
            ['rejects ${name}', 3, 4],
            ["<'limit ' + n>", 2, 6],
            ['plain', 1, 7],
        ]);
    });

    test('ignores test-like text in strings, templates, comments, regular expressions, and member calls', async () => {
        const { scanSource } = await load();
        const inventory = scanSource([
            "// test('commented out', () => {});",
            "/* it('also commented out') */",
            "const text = 'test(\"quoted\")' + `${'}'} test('templated')`;",
            "suite('checks', () => {",
            "    test('real', () => { /test\\(/.test(text); text.test; const half = 4 / 2 / 1; });",
            '});',
        ].join('\n'));
        assert.deepEqual(inventory.tests.map(entry => [entry.suites, entry.title]), [[['checks'], 'real']]);
        assert.equal(inventory.count, 1);
    });

    test('reports tests it cannot count exactly instead of guessing', async () => {
        const { scanSource } = await load();
        const inventory = scanSource([
            "describe('uncountable', () => {",
            "    if (process.platform === 'win32') { test('conditional', () => {}); }",
            "    function define() { test('in a helper', () => {}); }",
            "    for (const key of Object.keys({ a: 1 })) { test('computed', () => {}); }",
            "    test('nested', () => { test('inner', () => {}); });",
            '});',
        ].join('\n'));
        assert.deepEqual(inventory.problems.map(problem => problem.line), [2, 3, 4, 5]);
        assert.match(inventory.problems[2].message, /does not iterate over an array literal or a const array/);
    });

    test('records suite paths, modifiers, and Restricted Mode scenarios', async () => {
        const { scanSource } = await load();
        const inventory = scanSource([
            "describe('outer', () => {",
            "    describe.only('inner', function () {",
            "        test.skip('skipped', () => {});",
            "        it('aliased', () => {});",
            '    });',
            '});',
        ].join('\n'));
        assert.deepEqual(inventory.tests.map(entry => [entry.suites.join(' > '), entry.title, entry.modifier]), [
            ['outer > inner', 'skipped', 'skip'],
            ['outer > inner', 'aliased', undefined],
        ]);
        const scenarios = scanSource("console.log('PASS: blocks Git.');\nconsole.log('ready');\n", 'scenarios');
        assert.deepEqual(scenarios.tests.map(entry => entry.title), ['blocks Git.']);
    });
});

describe('test plan check', () => {
    const plan = (count: number, cited: string) => [
        '<!-- test-inventory:begin -->',
        '| Layer | Runner | Test sources | Count |',
        '| ----- | ------ | ------------ | ----: |',
        `| unit | node:test | \`src/test/unit/**/*.test.ts\` | ${count} |`,
        '<!-- test-inventory:end -->',
        '<!-- traceability:begin -->',
        '| Risk | Layer | Test files | Representative tests |',
        '| ---- | ----- | ---------- | -------------------- |',
        `| R1 | unit | [\`src/test/unit/a.test.ts\`](src/test/unit/a.test.ts) | "${cited}", with a note |`,
        '<!-- traceability:end -->',
    ].join('\n');

    async function layers(): Promise<Layer[]> {
        const { scanSource } = await load();
        const file = { file: 'src/test/unit/a.test.ts', ...scanSource("test('finds the base', () => {});\n") };
        return [{ id: 'unit', dir: 'src/test/unit', kind: 'tests', files: [file], count: file.count }];
    }

    test('accepts a plan whose counts and cited titles match the sources', async () => {
        const { checkPlan } = await load();
        assert.deepEqual(checkPlan(plan(1, 'finds the base'), await layers()), []);
    });

    test('names stale counts, missing tables, and cited titles that no longer exist', async () => {
        const { checkPlan } = await load();
        const sources = await layers();
        assert.deepEqual(checkPlan(plan(2, 'finds the base'), sources), [
            'TEST_PLAN.md states 2 tests for the unit layer, but src/test/unit defines 1. Update the inventory table; '
                + 'run node scripts/test-inventory.mjs --list to see them.',
        ]);
        assert.deepEqual(checkPlan(plan(1, 'finds a base'), sources), [
            'TEST_PLAN.md cites "finds a base", which src/test/unit/a.test.ts no longer defines.',
        ]);
        assert.match(checkPlan('# No inventory\n', sources).join('\n'), /has no <!-- test-inventory:begin -->/);
    });
});
