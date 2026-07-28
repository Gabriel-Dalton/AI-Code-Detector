/**
 * Shared Chromium launcher for the two Playwright-driven dev scripts.
 *
 * Playwright pins an exact browser revision and refuses to launch anything
 * else, which is the right default for a test matrix and the wrong one here:
 * these scripts read colours and take pictures, so any recent Chromium will
 * do. Sandboxes and CI images very often already ship one at a revision the
 * installed playwright doesn't recognise, and the stock failure for that is a
 * wall of text telling you to re-download a browser you already have.
 *
 * So: honour CHROMIUM_PATH, otherwise try the browsers Playwright manages,
 * otherwise fall back to whatever Chromium is on the system — and if none of
 * that works, say which paths were tried.
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PW_ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH;

// Playwright's own layout is <root>/chromium-<revision>/chrome-linux/chrome,
// with the revision floating between releases, so it is globbed rather than
// hard-coded.
function playwrightManaged() {
    if (!PW_ROOT || !existsSync(PW_ROOT)) return [];
    const candidates = [];
    for (const dir of readdirSync(PW_ROOT)) {
        if (!dir.startsWith('chromium-')) continue;
        candidates.push(
            join(PW_ROOT, dir, 'chrome-linux', 'chrome'),
            join(PW_ROOT, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
        );
    }
    // Newest revision first.
    return candidates.reverse();
}

const SYSTEM = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

/**
 * Launch Chromium, or exit with a message that names what was tried.
 * `opts` is passed through to playwright's chromium.launch().
 */
export async function launchChromium(opts = {}) {
    const tried = [];

    // An explicit path is a promise from the caller, so a failure there is
    // reported rather than silently worked around.
    if (process.env.CHROMIUM_PATH) {
        return chromium.launch({ executablePath: process.env.CHROMIUM_PATH, ...opts });
    }

    // Playwright's own resolution first: if the revisions line up, use it.
    try {
        return await chromium.launch(opts);
    } catch (err) {
        tried.push(`playwright's managed browser (${firstLine(err)})`);
    }

    for (const executablePath of [...playwrightManaged(), ...SYSTEM]) {
        if (!existsSync(executablePath)) continue;
        try {
            return await chromium.launch({ executablePath, ...opts });
        } catch (err) {
            tried.push(`${executablePath} (${firstLine(err)})`);
        }
    }

    console.error('Could not start Chromium. Tried:');
    for (const t of tried) console.error(`  - ${t}`);
    console.error('\nInstall one with `npx playwright install chromium`, or point');
    console.error('CHROMIUM_PATH at an existing Chromium or Chrome binary.');
    process.exit(1);
}

const firstLine = (err) => String(err.message || err).split('\n')[0].trim();
