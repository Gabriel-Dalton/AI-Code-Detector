/**
 * Checks on the repository itself rather than on the code it contains.
 *
 * Documentation drift is the failure mode a project this size actually suffers
 * from: a screenshot that no longer exists, a version bumped in one of three
 * places, a licence the README promises and the repo doesn't ship. None of that
 * shows up in a functional test, and all of it is what someone arriving at the
 * repo sees first.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const changelog = read('CHANGELOG.md');
const html = read('index.html');

describe('the version is the same everywhere', () => {
    test('package.json has a semver version', () => {
        assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    });

    test('the masthead eyebrow matches package.json', () => {
        // The eyebrow shows major.minor ("v1.0"), not the patch — a patch
        // release shouldn't require touching the markup.
        const [major, minor] = pkg.version.split('.');
        const m = html.match(/class="eyebrow">v(\d+\.\d+)/);
        assert.ok(m, 'no version found in the masthead eyebrow');
        assert.equal(m[1], `${major}.${minor}`,
            `index.html says v${m[1]}, package.json says ${pkg.version}`);
    });

    test('the changelog has an entry for the current version', () => {
        assert.ok(changelog.includes(`## [${pkg.version}]`),
            `CHANGELOG.md has no "## [${pkg.version}]" section`);
    });

    test('the newest changelog entry is the current version', () => {
        // Guards the release mistake of adding a section but forgetting the
        // bump, or bumping and describing it under the old heading.
        const first = changelog.match(/^## \[([^\]]+)\]/m);
        assert.ok(first, 'CHANGELOG.md has no version sections');
        assert.equal(first[1], pkg.version,
            `the top changelog entry is ${first[1]}, package.json is ${pkg.version}`);
    });

    test('every changelog version has a link definition', () => {
        for (const [, version] of changelog.matchAll(/^## \[([^\]]+)\]/gm)) {
            if (version.toLowerCase() === 'unreleased') continue;
            assert.match(changelog, new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]:`, 'm'),
                `no link definition for [${version}]`);
        }
    });
});

describe('the community health files exist', () => {
    for (const file of [
        'LICENSE',
        'README.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'CODE_OF_CONDUCT.md',
        'SECURITY.md',
        '.editorconfig',
        '.github/workflows/ci.yml',
        '.github/pull_request_template.md'
    ]) {
        test(file, () => {
            assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
            assert.ok(read(file).trim().length > 0, `${file} is empty`);
        });
    }

    test('the licence the README claims is the licence shipped', () => {
        // The README promised MIT for a long time with no LICENSE file behind
        // it, which is the kind of gap this check exists to keep closed.
        assert.match(read('LICENSE'), /MIT License/);
        assert.equal(pkg.license, 'MIT');
        assert.match(readme, /\bMIT\b/);
    });

    test('the bundled font licence is shipped with the fonts', () => {
        // The fonts are vendored under a different licence to the code; saying
        // so is a condition of the OFL, not a nicety.
        assert.ok(existsSync(join(ROOT, 'assets/fonts/LICENSE-OFL.txt')));
        assert.match(read('LICENSE'), /Open Font License/);
    });
});

describe('every relative link in the docs resolves', () => {
    const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md'];

    for (const doc of DOCS) {
        test(doc, () => {
            const body = read(doc);
            // Markdown images and links, skipping anchors, absolute URLs and
            // mailto:. Reference-style definitions are matched too.
            const targets = [
                ...body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g),
                ...body.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)
            ].map(m => m[1]);

            const missing = [];
            for (const target of targets) {
                if (/^(https?:|mailto:|#)/.test(target)) continue;
                const path = normalize(target.split('#')[0]);
                if (!path) continue;
                if (!existsSync(join(ROOT, path))) missing.push(target);
            }
            assert.deepEqual(missing, [], `${doc} links to missing files: ${missing.join(', ')}`);
        });
    }
});

describe('the screenshots and the README agree', () => {
    const embedded = [...readme.matchAll(/!\[[^\]]*\]\((docs\/images\/[^)\s]+)/g)].map(m => m[1]);

    test('the README embeds screenshots at all', () => {
        assert.ok(embedded.length > 0, 'the README embeds no figures');
    });

    test('every embedded screenshot exists', () => {
        const missing = embedded.filter(p => !existsSync(join(ROOT, p)));
        assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
    });

    test('no screenshot is orphaned', () => {
        // An unreferenced image is either a figure someone forgot to embed or
        // dead weight in the clone. Either way it wants noticing.
        const onDisk = readdirSync(join(ROOT, 'docs/images'))
            .filter(f => f.endsWith('.png'))
            .map(f => `docs/images/${f}`);
        const unused = onDisk.filter(p => !embedded.includes(p));
        assert.deepEqual(unused, [], `not referenced by the README: ${unused.join(', ')}`);
    });

    test('every screenshot the generator produces is one the README uses', () => {
        // Keeps scripts/screenshots.mjs and the README from drifting apart.
        const generated = [...read('scripts/screenshots.mjs').matchAll(/file: '([^']+\.png)'/g)]
            .map(m => `docs/images/${m[1]}`);
        assert.ok(generated.length > 0, 'no shots defined in scripts/screenshots.mjs');
        const notEmbedded = generated.filter(p => !embedded.includes(p));
        assert.deepEqual(notEmbedded, [],
            `the generator writes figures the README ignores: ${notEmbedded.join(', ')}`);
    });
});

describe('source hygiene', () => {
    const SOURCES = ['detector.js', 'script.js', 'examples.js', 'index.html', 'style.css'];

    test('no source file contains a stray control byte', () => {
        // A raw NUL in script.js used to make grep, file(1) and most editors
        // treat the file as binary. Written as an escape it behaves the same
        // and stays readable, so this pins that down.
        for (const file of SOURCES) {
            const bytes = readFileSync(join(ROOT, file));
            const found = [...bytes].filter(b => (b < 9 || (b > 13 && b < 32)));
            assert.deepEqual(found, [],
                `${file} contains control bytes: ${found.map(b => '0x' + b.toString(16)).join(', ')}`);
        }
    });

    test('every source file is valid UTF-8', () => {
        for (const file of SOURCES) {
            const bytes = readFileSync(join(ROOT, file));
            const decoded = new TextDecoder('utf-8', { fatal: true });
            assert.doesNotThrow(() => decoded.decode(bytes), `${file} is not valid UTF-8`);
        }
    });

    test('the app declares no runtime dependencies', () => {
        // The privacy claim in the masthead rests on this: no runtime deps and
        // no build step means there is nothing between the source and the page.
        assert.equal(pkg.dependencies, undefined,
            'the app is meant to have no runtime dependencies');
    });

    test('index.html loads nothing from a third-party origin', () => {
        // The masthead claims no network calls, and the fonts are vendored to
        // keep that true. A CDN link anywhere in the markup would make it false.
        const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
        const remote = external.filter(u => !u.startsWith('https://github.com/'));
        assert.deepEqual(remote, [],
            `index.html would fetch from: ${remote.join(', ')}`);
    });
});
