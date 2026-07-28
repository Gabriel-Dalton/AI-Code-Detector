/**
 * Every heuristic, twice: once against a snippet it must flag, once against a
 * snippet it must leave alone.
 *
 * The second half is the half that matters. A detector that fires on
 * everything scores 100% recall and is useless, so each signal carries a
 * `quiet` fixture chosen to sit just the other side of its threshold — the
 * same shape of code without the tell. That is what stops a "tighten this
 * regex" change from quietly turning a signal into an always-on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HEURISTICS, runHeuristics } = require('../detector.js');

const findingFor = (id, code) => {
    const f = runHeuristics(code).find(x => x.id === id);
    assert.ok(f, `no heuristic registered under id "${id}"`);
    return f;
};

/* --------------------------------------------------------------------------
   Fixtures. Kept inline and readable rather than in a data file: the point of
   each one is the *difference* between its two halves, which you can only see
   by reading them next to each other.
   -------------------------------------------------------------------------- */

const FIXTURES = {
    formatting_too_clean: {
        // Uniform 4-space steps, no trailing whitespace, no mixed indentation.
        fires: `function buildOrderSummary(order) {
    const lines = [];
    for (const line of order.lines) {
        lines.push({
            sku: line.sku,
            qty: line.qty
        });
    }
    return {
        lines: lines,
        total: order.total
    };
}`,
        // Same code, but three lines carry trailing whitespace — the kind of
        // scuff a human editor leaves behind and a generator does not.
        quiet: `function buildOrderSummary(order) {\n`
            + `    const lines = [];   \n`
            + `    for (const line of order.lines) {\n`
            + `        lines.push({\n`
            + `            sku: line.sku,  \n`
            + `            qty: line.qty\n`
            + `        });\n`
            + `    }\n`
            + `    return {\n`
            + `        lines: lines,\t\n`
            + `        total: order.total\n`
            + `    };\n`
            + `}\n`
    },

    generic_names: {
        fires: `function run(input) {
    const data = fetchAll(input);
    const result = [];
    for (const item of data) {
        result.push(transform(item));
    }
    return result;
}`,
        quiet: `function run(invoiceBatch) {
    const invoices = fetchAll(invoiceBatch);
    const reconciled = [];
    for (const invoice of invoices) {
        reconciled.push(applyLateFee(invoice));
    }
    return reconciled;
}`
    },

    lack_of_comments: {
        // 25+ non-empty lines with not one comment.
        fires: Array.from({ length: 28 }, (_, i) => `const step${i} = compute(${i});`).join('\n'),
        // Identical length, one comment. One is enough — the signal is
        // "literally zero", not "not many".
        quiet: '// Walk the pipeline stages in order.\n'
            + Array.from({ length: 28 }, (_, i) => `const step${i} = compute(${i});`).join('\n')
    },

    repetitive_lines: {
        // The signal counts *verbatim* duplicates, so the repetition has to be
        // literal — the same statement copy-pasted between each step, which is
        // what an unrolled generated block actually looks like.
        fires: `function seed(db) {
    db.insert('users', { name: 'ada' });
    logger.info('inserted');
    db.insert('users', { name: 'bob' });
    logger.info('inserted');
    db.insert('users', { name: 'cy' });
    logger.info('inserted');
    db.insert('users', { name: 'dee' });
    logger.info('inserted');
    return true;
}`,
        quiet: `function totals(rows) {
    const gross = rows.reduce((acc, row) => acc + row.amount, 0);
    const vat = gross * rateFor(rows[0].region);
    const rebate = gross > 5000 ? gross * 0.02 : 0;
    return { gross, vat, rebate, net: gross + vat - rebate };
}`
    },

    over_structured: {
        fires: `function classify(record) {
    if (record.kind === 'a') { return 1; }
    if (record.kind === 'b') { return 2; }
    for (const tag of record.tags) { if (tag === 'x') { return 3; } }
    while (record.parent) { record = record.parent; }
    switch (record.state) { case 'open': return 4; default: return 5; }
    if (record.archived) { return 6; }
}`,
        quiet: `function classify(record) {
    const table = { a: 1, b: 2, open: 4 };
    if (record.kind in table) return table[record.kind];
    return record.archived ? 6 : 5;
}`
    },

    human_complexity: {
        // A counterweight, not a tell: >10 distinct control keywords over
        // >20 lines reads as human variety and pulls the score down.
        fires: `class LedgerReplay {
    constructor(store) {
        this.store = store;
        var legacyMode = false;
        let cursor = 0;
        this.cursor = cursor;
        this.legacy = legacyMode;
    }

    async *walk(from) {
        for (const page of this.store.pages(from)) {
            try {
                if (page.sealed) {
                    yield await this.replay(page);
                } else if (page.partial) {
                    continue;
                } else {
                    throw new Error('torn page');
                }
            } catch (err) {
                while (this.retries-- > 0) {
                    return null;
                }
                switch (err.code) {
                    case 'TORN': break;
                    default: throw err;
                }
            }
        }
    }
}`,
        quiet: `function label(status) {
    return status === 'paid' ? 'Paid' : 'Outstanding';
}`
    },

    over_commenting_trivial_ops: {
        fires: `def total(rows):
    # Set the total to zero
    total = 0
    # Loop over the rows
    for row in rows:
        # Add the amount
        total += row.amount
    # Return the total
    return total`,
        quiet: `def total(rows):
    # Amounts arrive as minor units; the caller converts for display.
    return sum(row.amount for row in rows)


def rate_for(region):
    return REGION_RATES.get(region, DEFAULT_RATE)


def apply_rebate(gross):
    return gross * 0.02 if gross > 5000 else 0`
    },

    preamble_strings: {
        fires: `# Here's a function that reverses a string in place.
def reverse(chars):
    lo, hi = 0, len(chars) - 1
    while lo < hi:
        chars[lo], chars[hi] = chars[hi], chars[lo]
        lo += 1
        hi -= 1`,
        quiet: `# Reverses in place; callers rely on the aliasing.
def reverse(chars):
    lo, hi = 0, len(chars) - 1
    while lo < hi:
        chars[lo], chars[hi] = chars[hi], chars[lo]
        lo += 1
        hi -= 1`
    },

    excessive_try_except: {
        fires: `def load(user_id):
    try:
        user = db.fetch(user_id)
    except Exception as e:
        print(e)
        return None
    try:
        prefs = db.prefs(user_id)
    except Exception as e:
        print(e)
        return None
    return user, prefs`,
        quiet: `def load(user_id):
    try:
        user = db.fetch(user_id)
        prefs = db.prefs(user_id)
        audit.record(user_id, 'load')
    except RecordMissing:
        raise NotRegistered(user_id) from None
    return user, prefs`
    },

    jsdoc_on_everything: {
        fires: `/**
 * Adds two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function add(a, b) {
    return a + b;
}

/**
 * Multiplies two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function multiply(a, b) {
    return a * b;
}`,
        quiet: `/**
 * Applies the regional VAT table. Rates change quarterly and are sourced
 * from finance's spreadsheet, so this is the one place worth documenting.
 */
function vatFor(region, gross) {
    return gross * REGION_RATES[region];
}

function net(gross, vat, rebate) {
    return gross + vat - rebate;
}

function isSettled(invoice) {
    return invoice.paidAt !== undefined;
}`
    },

    defensive_null_checks: {
        fires: `def render(user, theme, locale):
    if user is None:
        return ""
    if theme is None:
        return ""
    if locale is None:
        return ""
    if not user:
        return ""
    return template(user, theme, locale)`,
        quiet: `def render(user, theme, locale):
    if user is None:
        raise ValueError("render() needs a user")
    body = template(user, theme, locale)
    header = banner(theme)
    footer = legal(locale)
    return header + body + footer`
    },

    symmetric_helper_names: {
        fires: `function processOrder(order) { return order; }
function processRefund(refund) { return refund; }
function processChargeback(cb) { return cb; }`,
        // Three functions, but no shared prefix or suffix, and each body is
        // long enough not to read as a one-liner sibling.
        quiet: `function reconcile(ledger, statement) {
    const byRef = new Map(statement.rows.map(r => [r.ref, r]));
    const unmatched = ledger.rows.filter(r => !byRef.has(r.ref));
    ledger.flag(unmatched);
    return unmatched.length;
}

function settle(invoice, payment) {
    invoice.applied.push(payment);
    const outstanding = invoice.total - sumOf(invoice.applied);
    invoice.status = outstanding <= 0 ? 'paid' : 'partial';
    return outstanding;
}

function dunningLetter(invoice, stage) {
    const template = TEMPLATES[stage];
    const overdue = daysBetween(invoice.dueAt, today());
    const body = template.replace('{{days}}', String(overdue));
    return { to: invoice.contact, body: body, stage: stage };
}`
    },

    no_todo_fixme: {
        fires: Array.from({ length: 26 }, (_, i) => `const stage${i} = pipeline.step(${i});`).join('\n'),
        quiet: '// TODO: collapse these into a single pass once the API supports batching.\n'
            + Array.from({ length: 26 }, (_, i) => `const stage${i} = pipeline.step(${i});`).join('\n')
    }
};

/* -------------------------------------------------------------------------- */

describe('each heuristic fires on its positive fixture', () => {
    for (const { id, label } of HEURISTICS) {
        test(`${id} — ${label}`, () => {
            const fixture = FIXTURES[id];
            assert.ok(fixture, `no fixture for "${id}"`);
            const f = findingFor(id, fixture.fires);
            assert.equal(f.matched, true, `expected ${id} to match its "fires" fixture`);
        });
    }
});

describe('each heuristic stays quiet on its negative fixture', () => {
    for (const { id, label } of HEURISTICS) {
        test(`${id} — ${label}`, () => {
            const f = findingFor(id, FIXTURES[id].quiet);
            assert.equal(f.matched, false, `expected ${id} NOT to match its "quiet" fixture`);
        });
    }
});

describe('registry invariants', () => {
    test('every registered heuristic has a fixture pair', () => {
        // Adding a signal without a test should fail the build, not slip
        // through as untested surface area.
        const missing = HEURISTICS.filter(h => !FIXTURES[h.id]).map(h => h.id);
        assert.deepEqual(missing, [], `heuristics with no fixture: ${missing.join(', ')}`);
    });

    test('no fixture refers to a heuristic that no longer exists', () => {
        const ids = new Set(HEURISTICS.map(h => h.id));
        const orphans = Object.keys(FIXTURES).filter(id => !ids.has(id));
        assert.deepEqual(orphans, [], `fixtures for unknown ids: ${orphans.join(', ')}`);
    });

    test('ids and labels are unique', () => {
        assert.equal(new Set(HEURISTICS.map(h => h.id)).size, HEURISTICS.length);
        assert.equal(new Set(HEURISTICS.map(h => h.label)).size, HEURISTICS.length);
    });

    test('every heuristic is documented for the Heuristics tab', () => {
        for (const h of HEURISTICS) {
            assert.equal(typeof h.about, 'string', `${h.id} has no about text`);
            assert.ok(h.about.length > 20, `${h.id}'s about text is too thin to render`);
        }
    });

    test('maxWeight is the magnitude of weight', () => {
        // The scoring denominator is the sum of maxWeights, so a mismatch here
        // silently rescales every verdict in the app.
        for (const h of HEURISTICS) {
            assert.equal(h.maxWeight, Math.abs(h.weight), `${h.id}: maxWeight != |weight|`);
        }
    });

    test('exactly one counterweight, and it is the human signal', () => {
        const negative = HEURISTICS.filter(h => h.weight < 0).map(h => h.id);
        assert.deepEqual(negative, ['human_complexity']);
    });
});

describe('evidence is well-formed', () => {
    test('cited line numbers exist in the snippet', () => {
        for (const [id, fixture] of Object.entries(FIXTURES)) {
            const f = findingFor(id, fixture.fires);
            const lineCount = fixture.fires.split('\n').length;
            for (const e of f.evidence) {
                // 0 is the sentinel for "this is about the whole snippet"
                // (counts and densities), so it has no line to point at.
                assert.ok(
                    e.line === 0 || (e.line >= 1 && e.line <= lineCount),
                    `${id}: evidence cites line ${e.line}, snippet has ${lineCount}`
                );
                assert.equal(typeof e.snippet, 'string');
                assert.ok(e.snippet.length > 0, `${id}: empty evidence snippet`);
            }
        }
    });

    test('a matched signal always shows its work', () => {
        // The whole pitch of the tool is "every finding cites evidence". A
        // match with an empty evidence list renders as an unexplained claim.
        for (const [id, fixture] of Object.entries(FIXTURES)) {
            const f = findingFor(id, fixture.fires);
            assert.equal(f.matched, true, `${id} did not match its own "fires" fixture`);
            assert.ok(f.evidence.length > 0, `${id} matched but produced no evidence`);
        }
    });

    test('an unmatched signal never carries evidence', () => {
        for (const [id, fixture] of Object.entries(FIXTURES)) {
            const f = findingFor(id, fixture.quiet);
            assert.deepEqual(f.evidence, [], `${id} did not match but still returned evidence`);
        }
    });

    test('every finding carries a human-readable reason', () => {
        for (const f of runHeuristics(FIXTURES.generic_names.fires)) {
            assert.equal(typeof f.reason, 'string', `${f.id} has no reason`);
            assert.ok(f.reason.length > 10, `${f.id}'s reason is too thin`);
        }
    });
});

describe('degenerate input', () => {
    // These used to be the easy way to get a stack trace out of the analyzer.
    for (const [name, code] of [
        ['empty string', ''],
        ['a single newline', '\n'],
        ['whitespace only', '   \n\t\n   '],
        ['one character', 'x'],
        ['no trailing newline', 'const a = 1;'],
        ['CRLF line endings', 'const a = 1;\r\nconst b = 2;\r\n'],
        ['an unterminated string literal', 'const s = "open;\nconst t = 2;'],
        ['an unterminated block comment', '/* open\nconst t = 2;'],
        ['a lone surrogate', 'const s = "\ud800";'],
        ['a very long single line', 'const a = ' + '1 + '.repeat(5000) + '1;']
    ]) {
        test(`survives ${name}`, () => {
            const findings = runHeuristics(code);
            assert.equal(findings.length, HEURISTICS.length);
            for (const f of findings) assert.equal(typeof f.matched, 'boolean');
        });
    }
});
