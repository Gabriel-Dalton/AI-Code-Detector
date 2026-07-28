/**
 * Regenerates every screenshot the README embeds.
 *
 * The README's figures are a claim about what the app currently looks like, and
 * hand-taken screenshots stop being true the moment anyone touches the CSS.
 * This makes them a build artefact instead: one command, same framing every
 * time, so a UI change comes with matching pictures in the same commit.
 *
 * Determinism is the whole point, so each shot:
 *   - runs at a fixed viewport and 2x scale;
 *   - waits for the webfonts, because a fallback-font render is a different
 *     picture and a slower machine would otherwise produce a different file;
 *   - suppresses transitions and caret blink, which are the two things that
 *     make otherwise identical runs produce different bytes;
 *   - starts from cleared localStorage, so a previous run's pinned theme or
 *     persisted snippet can't leak into the next one;
 *   - loads a named example rather than typing, so the code shown is fixed.
 *
 * Usage:
 *   npm run serve &
 *   npm run screenshots
 */

import { launchChromium } from './browser.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.SHOT_URL || 'http://127.0.0.1:8899/index.html';
const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'images');

const WIDE = { width: 1440, height: 1000 };
const WIDE_TALL = { width: 1440, height: 1240 };
const PHONE = { width: 414, height: 1000 };

/* The example the wide shots analyse. Picked because it lights up five signals
   at once, so the verdict panel has enough in it to be worth looking at. */
const FEATURED = 'js-jsdoc-on-everything';

/* Injected before each shot. Transitions and the textarea caret are the two
   sources of run-to-run pixel noise; `prefers-reduced-motion` isn't enough
   because it only disables what the stylesheet chose to gate on it. */
const FREEZE = `
    *, *::before, *::after {
        transition-duration: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
    }
    .editor-input { caret-color: transparent !important; }
`;

/* Framing rule for the whole set. GitHub renders README images into a column
   about 880px wide, so a 1440px-wide capture is shown at roughly 60% and its
   14px interface text lands near 8px — legible as a shape, useless as text.
   The layout shots accept that (their subject *is* the shape) and the detail
   shots are cropped to around 900 CSS px, where they arrive close to 1:1.
   `fullPage` is opt-in for the same reason: a 3500px-tall figure scales down
   twice as hard and buries its own subject. */

/**
 * Every figure in the README, in the order the README uses them.
 * `prepare` drives the page into the state worth photographing.
 */
const SHOTS = [
    {
        file: '01-analyze.png',
        caption: 'The workbench: source on the left, evidence-backed verdict on the right.',
        viewport: WIDE,
        async prepare(page) {
            await loadFeatured(page);
        }
    },
    {
        file: '02-evidence.png',
        caption: 'Findings cite their lines; hovering one lights those lines in the editor.',
        viewport: WIDE,
        async prepare(page) {
            await loadFeatured(page);
            // Expand the overflow rows so the citations are visible rather than
            // hidden behind "show N more", then rest the pointer on a row so
            // the hover highlight is live in the shot.
            const more = page.locator('.evidence-more').first();
            if (await more.count()) await more.click();
            await page.locator('.evidence-row').first().hover();
            await settle(page);
        },
        // Spans the seam between the two columns: the hovered evidence row on
        // the right and the lines it lit on the left have to be in one frame,
        // because the relationship between them *is* the feature.
        clip: { x: 60, y: 330, width: 1330, height: 620 }
    },
    {
        file: '03-gallery.png',
        caption: 'Annotated samples, each explaining which signal it demonstrates and why.',
        viewport: WIDE_TALL,
        async prepare(page) {
            await page.locator('#tab-gallery').click();
            await settle(page);
        }
    },
    {
        file: '04-heuristics.png',
        caption: 'Every signal documented in-app with its weight and tone.',
        viewport: WIDE_TALL,
        async prepare(page) {
            await page.locator('#tab-docs').click();
            await settle(page);
        }
    },
    {
        file: '05-example-picker.png',
        caption: 'The example picker: an ARIA combobox, so the open list follows the palette.',
        viewport: WIDE,
        async prepare(page) {
            await page.locator('#exampleComboButton').click();
            await settle(page);
        },
        // Just the open list. The button itself sits underneath it, so there
        // is nothing gained by framing wider.
        clip: { x: 100, y: 350, width: 620, height: 250 }
    },
    {
        file: '06-dark.png',
        caption: 'The same verdict in the dark palette.',
        viewport: WIDE,
        colorScheme: 'dark',
        async prepare(page) {
            await loadFeatured(page);
        }
    },
    {
        file: '07-mobile.png',
        caption: 'At phone width the workbench stacks and the editor keeps its gutter.',
        viewport: PHONE,
        async prepare(page) {
            await loadFeatured(page);
        }
    }
];

/* -------------------------------------------------------------------------- */

const settle = (page) => page.waitForTimeout(250);

// Selecting from the combobox by visible option rather than by index, so
// reordering examples.js doesn't silently change which sample is pictured.
async function loadFeatured(page) {
    const id = await page.evaluate((wanted) => {
        const examples = window.AI_CODE_EXAMPLES || [];
        const i = examples.findIndex(e => e.id === wanted);
        return i === -1 ? null : `exampleComboList-opt-${i}`;
    }, FEATURED);

    if (!id) throw new Error(`no example with id "${FEATURED}" — update FEATURED in this script`);

    await page.locator('#exampleComboButton').click();
    await page.locator(`#${id}`).click();
    // Loading an example analyses it; wait for the verdict to actually render
    // rather than guessing at a delay.
    await page.locator('#result-summary .verdict-score').waitFor({ timeout: 5000 });
    await settle(page);
}

async function main() {
    mkdirSync(OUT, { recursive: true });
    const browser = await launchChromium();

    for (const shot of SHOTS) {
        const ctx = await browser.newContext({
            viewport: shot.viewport,
            deviceScaleFactor: 2,
            colorScheme: shot.colorScheme || 'light',
            reducedMotion: 'reduce'
        });
        const page = await ctx.newPage();
        await page.addStyleTag({ content: FREEZE }).catch(() => {});
        await page.goto(BASE, { waitUntil: 'networkidle' });

        // The app restores its last input from localStorage, so a stale entry
        // would put someone else's snippet in the picture.
        await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* private mode */ } });
        await page.reload({ waitUntil: 'networkidle' });
        await page.addStyleTag({ content: FREEZE });
        await page.evaluate(() => document.fonts.ready);

        await shot.prepare(page);

        // Viewport-sized unless a shot opts into fullPage. The gallery is eight
        // cards tall, so capturing all of it produces an 8000px strip that no
        // README can show usefully — one screenful communicates the layout and
        // stays readable.
        await page.screenshot({
            path: join(OUT, shot.file),
            fullPage: Boolean(shot.fullPage),
            clip: shot.clip
        });
        console.log(`  ${shot.file}`);
        await ctx.close();
    }

    await browser.close();
    console.log(`\n✓ ${SHOTS.length} screenshots written to docs/images/`);
}

await main();
