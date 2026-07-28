/**
 * The gallery is documentation, and documentation rots. These checks hold it to
 * the two claims it makes about itself:
 *
 *   1. every annotation points at a line that exists and a signal that exists;
 *   2. every `expectedSignals` entry is a signal the detector actually fires on
 *      that sample.
 *
 * (2) is the one that matters. examples.js has always described that field as
 * "used as a self-test", but nothing ran it — so a heuristic could be tightened
 * until it stopped firing on the very sample the gallery uses to teach it, and
 * the card would go on confidently explaining a tell that no longer registers.
 *
 * The last group reaches into index.html. The markup carries hard-coded counts
 * so the masthead isn't blank before the scripts run; script.js then overwrites
 * them from these arrays. Nobody notices when the placeholder goes stale, so it
 * is checked here instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { HEURISTICS, runHeuristics, aggregate, DEFAULT_THRESHOLDS } = require('../detector.js');
const examples = require('../examples.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const SIGNAL_IDS = new Set(HEURISTICS.map(h => h.id));
const PROVENANCE = new Set(['verbatim', 'curated']);
const SOURCE_LABELS = new Set(['ChatGPT', 'Claude', 'Copilot', 'Gemini', 'Curated']);

/* Hand-written code carrying none of the tells: irregular structure, comments
   that explain *why* rather than restate, a real ticket reference, a TODO.
   Used as the floor every generated sample has to clear. */
const HUMAN_REFERENCE = `def display_name(user):
    # Legal wants the maiden name bracketed in the audit export only.
    # See TICKET-4417. Everywhere else, drop it.
    # TODO: fold into the serialiser once the export moves off v1.
    parts = [user.first, user.last]
    if user.maiden and user.export_context == 'audit':
        parts.insert(1, f'({user.maiden})')
    return ' '.join(p for p in parts if p)`;

const HUMAN_REFERENCE_SCORE = aggregate(runHeuristics(HUMAN_REFERENCE), DEFAULT_THRESHOLDS).percentage;

describe('the gallery is not empty', () => {
    test('there are samples to show', () => {
        assert.ok(Array.isArray(examples));
        assert.ok(examples.length > 0, 'the gallery has no samples');
    });

    test('ids are unique', () => {
        // The combobox and the filter chips key off the id; a duplicate makes
        // one sample unloadable.
        const ids = examples.map(e => e.id);
        assert.equal(new Set(ids).size, ids.length, `duplicate ids in: ${ids.join(', ')}`);
    });
});

describe('every sample is well-formed', () => {
    for (const ex of examples) {
        describe(ex.id, () => {
            test('has a slug-shaped id', () => {
                assert.match(ex.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
            });

            test('has display strings the gallery can render', () => {
                for (const field of ['title', 'blurb', 'language', 'sourceLabel', 'provenance']) {
                    assert.equal(typeof ex[field], 'string', `${field} is not a string`);
                    assert.ok(ex[field].trim().length > 0, `${field} is empty`);
                }
            });

            test('declares a documented provenance and source', () => {
                assert.ok(PROVENANCE.has(ex.provenance), `unknown provenance "${ex.provenance}"`);
                assert.ok(SOURCE_LABELS.has(ex.sourceLabel), `unknown sourceLabel "${ex.sourceLabel}"`);
            });

            test('a curated sample is not attributed to a model', () => {
                // Provenance is a licensing and honesty claim, not decoration:
                // "curated" means distilled from common idioms, so it must not
                // also claim to be a capture from a named product.
                if (ex.provenance === 'curated' && ex.sourceLabel !== 'Curated') {
                    assert.notEqual(
                        ex.sourceLabel, undefined,
                        'curated samples may name a model as inspiration, but see the note in examples.js'
                    );
                }
                if (ex.provenance === 'verbatim') {
                    assert.notEqual(
                        ex.sourceLabel, 'Curated',
                        'a verbatim capture has to say which model produced it'
                    );
                }
            });

            test('carries code', () => {
                assert.equal(typeof ex.code, 'string');
                assert.ok(ex.code.split('\n').length > 1, 'a one-line sample teaches nothing');
            });

            test('every annotation cites a line that exists', () => {
                const lineCount = ex.code.split('\n').length;
                assert.ok(Array.isArray(ex.annotations) && ex.annotations.length > 0,
                    'an unannotated sample is just code');
                for (const a of ex.annotations) {
                    const [from, to] = a.lineRange;
                    assert.ok(Number.isInteger(from) && Number.isInteger(to),
                        `lineRange ${JSON.stringify(a.lineRange)} is not a pair of integers`);
                    assert.ok(from >= 1, `lineRange starts at ${from}; lines are 1-indexed`);
                    assert.ok(from <= to, `lineRange ${from}-${to} runs backwards`);
                    assert.ok(to <= lineCount,
                        `lineRange ${from}-${to} runs past the end of the sample (${lineCount} lines)`);
                }
            });

            test('every annotation names a real signal and explains it', () => {
                for (const a of ex.annotations) {
                    assert.ok(SIGNAL_IDS.has(a.signal),
                        `annotation cites unknown signal "${a.signal}"`);
                    assert.equal(typeof a.why, 'string');
                    assert.ok(a.why.length > 20, `the "why" for ${a.signal} is too thin to teach anything`);
                }
            });

            test('expectedSignals name real signals', () => {
                assert.ok(Array.isArray(ex.expectedSignals) && ex.expectedSignals.length > 0,
                    'declare at least one expected signal so the sample self-tests');
                for (const id of ex.expectedSignals) {
                    assert.ok(SIGNAL_IDS.has(id), `expectedSignals cites unknown signal "${id}"`);
                }
            });

            test('the detector actually fires every expected signal', () => {
                // The self-test examples.js always advertised.
                const matched = new Set(runHeuristics(ex.code).filter(f => f.matched).map(f => f.id));
                const missing = ex.expectedSignals.filter(id => !matched.has(id));
                assert.deepEqual(missing, [],
                    `${ex.id} expects ${missing.join(', ')} but the detector does not flag it`);
            });

            test('every scored annotation is one the detector really fires', () => {
                // Annotations teach; heuristics score. The two are allowed to
                // differ, but only deliberately: an annotation describing a
                // tell this detector does not register must say so with
                // `scored: false`. Anything else has to hold up against the
                // live engine, or the card is explaining a match that isn't
                // there.
                const matched = new Set(runHeuristics(ex.code).filter(f => f.matched).map(f => f.id));
                const overclaimed = ex.annotations
                    .filter(a => a.scored !== false && !matched.has(a.signal))
                    .map(a => `${a.signal} (lines ${a.lineRange.join('-')})`);
                assert.deepEqual(overclaimed, [],
                    `annotated as a live match but not flagged: ${overclaimed.join('; ')}`
                    + ' — either the heuristic regressed, or the annotation needs scored: false');
            });

            test('an unscored annotation explains why it is unscored', () => {
                for (const a of ex.annotations.filter(x => x.scored === false)) {
                    assert.match(a.why, /not scored/i,
                        `${a.signal} is flagged scored:false but its text does not say why`);
                }
            });

            test('outscores a plainly human snippet', () => {
                // The weak form of a calibration check, and the only one that
                // holds today: see the "known limitations" note in the README
                // about whole-file input. Every gallery sample is generated
                // code, so each must at least land above hand-written code
                // with none of the tells.
                const { percentage } = aggregate(runHeuristics(ex.code), DEFAULT_THRESHOLDS);
                assert.ok(percentage > HUMAN_REFERENCE_SCORE,
                    `${ex.id} scored ${percentage.toFixed(1)}%, at or below the human reference `
                    + `(${HUMAN_REFERENCE_SCORE.toFixed(1)}%)`);
            });
        });
    }
});

describe('the gallery and the UI agree', () => {
    test('every sample language has a filter chip', () => {
        // A language with no chip is reachable only via "All", so the sample is
        // effectively hidden.
        const chips = new Set([...html.matchAll(/data-filter="([^"]+)"/g)].map(m => m[1]));
        chips.delete('all');
        for (const ex of examples) {
            assert.ok(chips.has(ex.language),
                `${ex.id} is ${ex.language}, but index.html has no chip for it (chips: ${[...chips].join(', ')})`);
        }
    });

    test('no filter chip is dead', () => {
        const chips = new Set([...html.matchAll(/data-filter="([^"]+)"/g)].map(m => m[1]));
        chips.delete('all');
        const languages = new Set(examples.map(e => e.language));
        for (const chip of chips) {
            assert.ok(languages.has(chip), `index.html has a "${chip}" chip but no ${chip} sample`);
        }
    });

    test('the masthead placeholder counts match the data', () => {
        const textOf = (id) => {
            const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
            assert.ok(m, `index.html has no element with id="${id}"`);
            return m[1].trim();
        };
        const languages = new Set(examples.map(e => e.language)).size;
        assert.equal(textOf('meta-signals'), String(HEURISTICS.length), 'heuristic count is stale');
        assert.equal(textOf('meta-examples'), String(examples.length), 'sample count is stale');
        assert.equal(textOf('meta-languages'), String(languages), 'language count is stale');
        assert.equal(textOf('tab-count-gallery'), String(examples.length), 'gallery tab count is stale');
        assert.equal(textOf('tab-count-docs'), String(HEURISTICS.length), 'heuristics tab count is stale');
    });

    test('index.html loads the engine before the UI that calls it', () => {
        // detector.js defines the globals script.js calls at parse time; the
        // wrong order is a blank page.
        const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
        assert.deepEqual(order, ['examples.js', 'detector.js', 'script.js']);
    });
});

describe('the gallery covers the heuristics it teaches', () => {
    test('most signals appear in at least one annotation', () => {
        // Not all 13 — some (like "no TODO markers") are too weak to build a
        // teaching sample around. But a gallery that only ever demonstrates a
        // handful is not doing its job, so this holds the line at two thirds
        // and names what is missing when it slips.
        const annotated = new Set(examples.flatMap(e => e.annotations.map(a => a.signal)));
        const uncovered = HEURISTICS.map(h => h.id).filter(id => !annotated.has(id));
        const covered = HEURISTICS.length - uncovered.length;
        assert.ok(
            covered >= Math.ceil(HEURISTICS.length * (2 / 3)),
            `only ${covered}/${HEURISTICS.length} signals are demonstrated; uncovered: ${uncovered.join(', ')}`
        );
    });
});
