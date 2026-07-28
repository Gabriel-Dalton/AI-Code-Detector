/**
 * The scoring layer: the arithmetic that turns findings into a percentage, the
 * threshold band that turns a percentage into a verdict, and the shared string
 * helpers the heuristics are built on.
 *
 * These are the parts with no visible output of their own — a wrong denominator
 * or an off-by-one band shifts every verdict in the app without any single
 * finding looking wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    HEURISTICS, runHeuristics, aggregate, normaliseThresholds, DEFAULT_THRESHOLDS,
    stripStrings, commentLineSet, snippet, clamp, dedupeEvidence
} = require('../detector.js');

// A finding shaped like the real thing, for arithmetic that shouldn't depend on
// any particular heuristic's behaviour.
const finding = (weight, matched) => ({ id: `w${weight}`, weight, maxWeight: Math.abs(weight), matched, evidence: [] });

describe('aggregate() arithmetic', () => {
    test('nothing matched scores zero', () => {
        const agg = aggregate([finding(1, false), finding(2, false)]);
        assert.equal(agg.percentage, 0);
        assert.equal(agg.verdict.tone, 'human');
    });

    test('everything matched scores 100', () => {
        const agg = aggregate([finding(1, true), finding(2, true)]);
        assert.equal(agg.percentage, 100);
        assert.equal(agg.verdict.tone, 'ai');
    });

    test('the score is matched weight over total possible weight', () => {
        // 1 of (1 + 3) => 25%
        const agg = aggregate([finding(1, true), finding(3, false)]);
        assert.equal(agg.percentage, 25);
        assert.equal(agg.sumMatched, 1);
        assert.equal(agg.sumMax, 4);
    });

    test('the denominator uses |weight|, so a counterweight cannot shrink it', () => {
        // A negative weight still contributes its magnitude to the total.
        const agg = aggregate([finding(2, true), finding(-2, false)]);
        assert.equal(agg.sumMax, 4);
        assert.equal(agg.percentage, 50);
    });

    test('a matched counterweight pulls the score down', () => {
        const withoutHuman = aggregate([finding(2, true), finding(-2, false)]).percentage;
        const withHuman = aggregate([finding(2, true), finding(-2, true)]).percentage;
        assert.ok(withHuman < withoutHuman, 'the human signal should reduce the score');
    });

    test('the score floors at 0 rather than going negative', () => {
        // Counterweights outweighing the tells must not produce -50%.
        const agg = aggregate([finding(1, false), finding(-2, true)]);
        assert.equal(agg.percentage, 0);
    });

    test('the score is reported alongside the thresholds that produced it', () => {
        // The meter draws its tick marks from this, so it has to travel with
        // the score rather than being re-read separately.
        const agg = aggregate([finding(1, true)], { mixed: 10, ai: 20 });
        assert.deepEqual(agg.thresholds, { mixed: 10, ai: 20 });
    });
});

describe('verdict bands', () => {
    const scoreOf = (pct) => {
        // Build a two-finding set that lands exactly on `pct`.
        const findings = [finding(pct, true), finding(100 - pct, false)];
        return aggregate(findings, DEFAULT_THRESHOLDS);
    };

    test('below the mixed threshold reads as human', () => {
        assert.equal(scoreOf(24).verdict.tone, 'human');
    });

    test('the mixed threshold is inclusive', () => {
        // "Mixed >= 25" in the UI has to mean >=, not >.
        assert.equal(scoreOf(25).verdict.tone, 'mixed');
    });

    test('between the thresholds reads as mixed', () => {
        assert.equal(scoreOf(49).verdict.tone, 'mixed');
    });

    test('the AI threshold is inclusive', () => {
        assert.equal(scoreOf(50).verdict.tone, 'ai');
    });

    test('every band has a label', () => {
        for (const pct of [0, 25, 50, 100]) {
            assert.equal(typeof scoreOf(pct).verdict.label, 'string');
            assert.ok(scoreOf(pct).verdict.label.length > 0);
        }
    });

    test('custom thresholds move the bands', () => {
        const findings = [finding(30, true), finding(70, false)]; // 30%
        assert.equal(aggregate(findings, { mixed: 10, ai: 20 }).verdict.tone, 'ai');
        assert.equal(aggregate(findings, { mixed: 60, ai: 80 }).verdict.tone, 'human');
    });
});

describe('normaliseThresholds()', () => {
    test('passes a sane pair through untouched', () => {
        assert.deepEqual(normaliseThresholds({ mixed: 30, ai: 70 }), { mixed: 30, ai: 70 });
    });

    test('falls back to the defaults on non-numeric input', () => {
        // parseInt('') is NaN, which is what an emptied number input yields.
        assert.deepEqual(normaliseThresholds({ mixed: NaN, ai: NaN }), DEFAULT_THRESHOLDS);
        assert.deepEqual(normaliseThresholds({}), DEFAULT_THRESHOLDS);
        assert.deepEqual(normaliseThresholds(), DEFAULT_THRESHOLDS);
    });

    test('clamps to 0..100', () => {
        const { mixed, ai } = normaliseThresholds({ mixed: -40, ai: 900 });
        assert.equal(mixed, 0);
        assert.equal(ai, 100);
    });

    test('keeps mixed strictly below ai when they are inverted', () => {
        const t = normaliseThresholds({ mixed: 80, ai: 20 });
        assert.ok(t.mixed < t.ai, `expected mixed < ai, got ${t.mixed}/${t.ai}`);
    });

    test('separates them when they are equal', () => {
        // Equal thresholds would collapse the mixed band to nothing.
        const t = normaliseThresholds({ mixed: 50, ai: 50 });
        assert.ok(t.mixed < t.ai, `expected mixed < ai, got ${t.mixed}/${t.ai}`);
    });

    test('every normalised pair leaves all three bands reachable', () => {
        for (const mixed of [0, 1, 25, 50, 99, 100]) {
            for (const ai of [0, 1, 25, 50, 99, 100]) {
                const t = normaliseThresholds({ mixed, ai });
                assert.ok(t.mixed < t.ai, `bands collapsed for input ${mixed}/${ai}`);
                const tones = new Set([0, t.mixed, t.ai, 100].map(
                    pct => aggregate([finding(pct, true), finding(100 - pct, false)], t).verdict.tone
                ));
                assert.ok(tones.size >= 2, `only one verdict reachable for ${mixed}/${ai}`);
            }
        }
    });
});

describe('end-to-end scoring', () => {
    test('a plainly generated snippet scores above a plainly human one', () => {
        // Not an assertion about any single signal — just that the whole panel,
        // wired together, orders these two the way a reader would.
        const generated = `# Here's a helper that formats a user's display name.
def format_display_name(data):
    # Check if data is None
    if data is None:
        # Return an empty string
        return ""
    # Get the first name
    first = data.get("first")
    # Get the last name
    last = data.get("last")
    # Join them together
    result = first + " " + last
    # Return the result
    return result`;

        const human = `def display_name(user):
    # Legal wants the maiden name shown in brackets for the audit export
    # only -- see TICKET-4417. Everywhere else, drop it.
    parts = [user.first, user.last]
    if user.maiden and user.export_context == "audit":
        parts.insert(1, f"({user.maiden})")
    return " ".join(p for p in parts if p)`;

        const scoreFor = (code) => aggregate(runHeuristics(code), DEFAULT_THRESHOLDS).percentage;
        const generatedScore = scoreFor(generated);
        const humanScore = scoreFor(human);
        assert.ok(
            generatedScore > humanScore,
            `generated scored ${generatedScore.toFixed(1)}, human scored ${humanScore.toFixed(1)}`
        );
    });

    test('the score stays in 0..100 across the whole gallery', () => {
        for (const example of require('../examples.js')) {
            const { percentage } = aggregate(runHeuristics(example.code), DEFAULT_THRESHOLDS);
            assert.ok(
                percentage >= 0 && percentage <= 100,
                `${example.id} scored ${percentage}, outside 0..100`
            );
        }
    });

    test('the denominator matches the registry', () => {
        // If these drift, every score in the app is scaled wrong.
        const expected = HEURISTICS.reduce((a, h) => a + Math.abs(h.maxWeight), 0);
        assert.equal(aggregate(runHeuristics('const a = 1;')).sumMax, expected);
    });
});

describe('shared helpers', () => {
    describe('stripStrings()', () => {
        test('blanks string contents so regexes cannot match inside them', () => {
            assert.equal(stripStrings('const s = "data";').includes('data'), false);
        });

        test('preserves length, so line and column references still line up', () => {
            // Every heuristic reports positions from the stripped copy, so the
            // two have to stay the same shape.
            for (const src of [
                'const s = "hello";',
                "const s = 'hi' + `there`;",
                'const s = "with \\"escapes\\" inside";',
                'x = "a"\ny = "bb"\nz = "ccc"'
            ]) {
                assert.equal(stripStrings(src).length, src.length, `length changed for: ${src}`);
                assert.equal(
                    stripStrings(src).split('\n').length, src.split('\n').length,
                    `line count changed for: ${src}`
                );
            }
        });

        test('keeps the quote characters themselves', () => {
            assert.match(stripStrings('const s = "data";'), /"\s+"/);
        });

        test('leaves code outside strings alone', () => {
            assert.match(stripStrings('if (payload === "x") return;'), /if \(payload === /);
        });
    });

    describe('commentLineSet()', () => {
        test('finds line, hash and block comments', () => {
            const set = commentLineSet('// one\n# two\n/* three */\ncode();');
            assert.deepEqual([...set].sort((a, b) => a - b), [1, 2, 3]);
        });

        test('spans a multi-line block comment', () => {
            const set = commentLineSet('/*\n * a\n * b\n */\ncode();');
            assert.deepEqual([...set].sort((a, b) => a - b), [1, 2, 3, 4]);
        });

        test('does not mistake multiplication for a comment', () => {
            // The bug this guards: a bare `*` at the start of a continuation
            // line used to read as a JSDoc body line.
            assert.equal(commentLineSet('const area = w\n    * h;').size, 0);
        });

        test('ignores comment markers inside string literals', () => {
            assert.equal(commentLineSet('const url = "https://example.com";').size, 0);
            assert.equal(commentLineSet('const s = "# not a comment";').size, 0);
        });

        test('is 1-indexed', () => {
            assert.deepEqual([...commentLineSet('code();\n// here')], [2]);
        });
    });

    describe('snippet()', () => {
        test('leaves a short line intact', () => {
            assert.equal(snippet('const a = 1;'), 'const a = 1;');
        });

        test('truncates with an ellipsis and respects the cap', () => {
            const out = snippet('x'.repeat(200), 20);
            assert.equal(out.length, 20);
            assert.ok(out.endsWith('…'));
        });

        test('trims trailing whitespace', () => {
            assert.equal(snippet('const a = 1;   '), 'const a = 1;');
        });
    });

    describe('clamp()', () => {
        test('bounds in both directions and passes the middle through', () => {
            assert.equal(clamp(-5, 0, 100), 0);
            assert.equal(clamp(150, 0, 100), 100);
            assert.equal(clamp(42, 0, 100), 42);
        });
    });

    describe('dedupeEvidence()', () => {
        test('collapses identical line/snippet pairs', () => {
            const rows = [{ line: 1, snippet: 'a' }, { line: 1, snippet: 'a' }, { line: 2, snippet: 'a' }];
            assert.equal(dedupeEvidence(rows).length, 2);
        });

        test('keeps the first occurrence, in order', () => {
            const rows = [{ line: 2, snippet: 'b' }, { line: 1, snippet: 'a' }, { line: 2, snippet: 'b' }];
            assert.deepEqual(dedupeEvidence(rows), [{ line: 2, snippet: 'b' }, { line: 1, snippet: 'a' }]);
        });

        test('does not conflate rows whose line and snippet run together', () => {
            // The separator has to be a character that cannot appear in either
            // field, or ("1", ":2") and ("1:", "2") would collide.
            const rows = [{ line: '1', snippet: ':2' }, { line: '1:', snippet: '2' }];
            assert.equal(dedupeEvidence(rows).length, 2);
        });

        test('handles an empty list', () => {
            assert.deepEqual(dedupeEvidence([]), []);
        });
    });
});
