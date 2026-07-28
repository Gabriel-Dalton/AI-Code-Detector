/**
 * WCAG contrast audit.
 *
 * Walks the real, rendered page in both themes across six interaction states,
 * then reports every pair that misses WCAG 2.1 AA:
 *
 *   1.4.3  Contrast (Minimum) — text: 4.5:1, or 3:1 when large
 *                               (>=24px, or >=18.66px at weight 700+)
 *   1.4.11 Non-text Contrast  — the boundary of an interactive control: 3:1
 *
 * It reads computed styles rather than the token table on purpose. light-dark(),
 * alpha compositing and tinted hover states all mean a token's declared value
 * tells you very little about what actually lands on screen.
 *
 * Usage:
 *   npx http-server -p 8899 -s &
 *   node scripts/contrast-audit.mjs
 *
 * Exits non-zero on any failure, so it can gate a commit or a CI job.
 * Needs playwright and a Chromium build; see scripts/browser.mjs for how one
 * is found, and set CHROMIUM_PATH to override.
 */

import { launchChromium } from './browser.mjs';

const BASE = process.env.AUDIT_URL || 'http://127.0.0.1:8899/index.html';

/* ---------------------------------------------------------------------------
   Injected into the page. Self-contained because it is serialised across the
   CDP boundary and cannot close over module scope.
   --------------------------------------------------------------------------- */
const AUDIT = () => {
    const parse = (c) => {
        const m = String(c).match(/[\d.]+/g);
        if (!m || m.length < 3) return null;
        return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
    };

    const lum = ({ r, g, b }) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };

    const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };

    const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1
    });

    // Composite every translucent background between `el` and the root.
    function bgOf(el) {
        const stack = [];
        for (let node = el; node; node = node.parentElement) {
            const c = parse(getComputedStyle(node).backgroundColor);
            if (c && c.a > 0) {
                stack.push(c);
                if (c.a === 1) break;
            }
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
    }

    const label = (el) =>
        `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].map(c => '.' + c).join('')}`;

    const rendered = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.opacity !== '0';
    };

    const fails = [];

    /* --- 1.4.3 text ------------------------------------------------------- */
    document.querySelectorAll('body *').forEach(el => {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (!own || !rendered(el)) return;

        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!fg || fg.a === 0) return;

        const bg = bgOf(el);
        const px = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const need = (px >= 24 || (px >= 18.66 && weight >= 700)) ? 3 : 4.5;
        const got = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);

        if (got + 0.005 < need) {
            fails.push({
                rule: '1.4.3', sel: label(el), got: +got.toFixed(2), need,
                detail: `${px}px/${weight}  ${cs.color} on rgb(${[bg.r, bg.g, bg.b].map(Math.round).join(', ')})`,
                text: own.slice(0, 40)
            });
        }
    });

    /* --- 1.4.11 control boundaries ---------------------------------------- */
    /* The normative wording is "visual information required to identify user
       interface components and states". That is narrower than "every border on
       every control", so three exemptions are applied deliberately rather than
       to make the numbers go green:

         - A control with no boundary at all is identified by its label, and
           the label is held to 1.4.3 above (see .evidence-row, .btn-quiet).
           There is no boundary to measure.
         - A single-edge divider is not a boundary and does not indicate a hit
           area (see .code-expand's border-top).
         - Hover is not a state that 1.4.11 requires to be perceivable; focus
           is, and it gets its own check below. So boundaries are measured at
           rest.

       Where a boundary does exist, either the border or the control's own fill
       may carry the 3:1 — a solid ink button on paper needs no outline. */
    document.querySelectorAll('button, input, select, textarea, [role="combobox"]').forEach(el => {
        if (!rendered(el) || el.matches(':hover')) return;

        const cs = getComputedStyle(el);
        const outer = bgOf(el.parentElement || document.body);

        const sides = ['Top', 'Right', 'Bottom', 'Left'].map(s => ({
            w: parseFloat(cs[`border${s}Width`]) || 0,
            c: parse(cs[`border${s}Color`])
        }));
        const enclosed = sides.every(s => s.w > 0 && s.c && s.c.a > 0);

        const fill = parse(cs.backgroundColor);
        const hasFill = fill && fill.a > 0;
        if (!enclosed && !hasFill) return;

        const fillRatio = hasFill ? ratio(over(fill, outer), outer) : 0;
        const borderRatio = enclosed
            ? Math.min(...sides.map(s => ratio(over(s.c, outer), outer)))
            : 0;

        const got = Math.max(borderRatio, fillRatio);
        if (got + 0.005 < 3) {
            fails.push({
                rule: '1.4.11', sel: label(el), got: +got.toFixed(2), need: 3,
                detail: `border ${borderRatio.toFixed(2)} / fill ${fillRatio.toFixed(2)} vs surroundings`,
                text: (el.value || el.textContent || '').trim().slice(0, 40)
            });
        }
    });

    /* --- 1.4.11 / 2.4.7 focus indicator ----------------------------------- */
    /* Checked at the token level, against every focusable control, rather than
       by walking the tab order. Two reasons: a tab walk only ever tests the
       controls it happens to reach (and the editor deliberately swallows Tab
       to insert an indent, so it traps the walk), and every ring on this page
       comes from one :focus-visible declaration — so verifying that one colour
       against every control's surroundings is both simpler and complete.
       The live outline is asserted separately, once, in the driver below. */
    /* getPropertyValue('--focus') returns the *specified* token — the literal
       "light-dark(a, b)" string — because custom properties are substituted,
       not resolved. Assigning it to a real colour property on a probe forces
       the cascade to resolve both the var() and the light-dark() for the
       current colour-scheme, which is the value that actually gets painted. */
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;top:-9999px;opacity:0;outline-color:var(--focus)';
    document.body.appendChild(probe);
    const ring = parse(getComputedStyle(probe).outlineColor);
    probe.remove();

    if (ring) {
        document.querySelectorAll(
            'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
        ).forEach(el => {
            if (!rendered(el) || el.disabled) return;
            // The ring is drawn just outside the control, so it is judged
            // against whatever the control sits on, not the control's own fill.
            const behind = bgOf(el.parentElement || document.body);
            const got = ratio(over(ring, behind), behind);
            if (got + 0.005 < 3) {
                fails.push({
                    rule: '1.4.11', sel: label(el), got: +got.toFixed(2), need: 3,
                    detail: `focus ring vs the surface behind this control`, text: ''
                });
            }
        });
    }

    return fails;
};

/* --------------------------------------------------------------------------- */

const browser = await launchChromium();
let total = 0;

for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const states = [];
    const capture = async (name) => states.push([name, await page.evaluate(AUDIT)]);

    await capture('empty');

    // A rendered verdict, with the unmatched drawer and the overflow evidence
    // rows expanded, and the pointer resting on a row so its tint is live.
    await page.locator('#exampleComboButton').click();
    await page.locator('#exampleComboList-opt-4').click();
    await page.waitForTimeout(400);
    await page.locator('.unmatched > summary').click();
    await page.locator('.evidence-more').first().click();
    await page.locator('.evidence-row').first().hover();
    await page.waitForTimeout(200);
    await capture('verdict');

    await page.locator('#exampleComboButton').click();
    await page.waitForTimeout(200);
    await capture('dropdown-open');
    await page.keyboard.press('Escape');

    // Assert once that keyboard focus actually paints a ring, so the
    // token-level check above cannot pass against an outline that was
    // removed. Tab from a clean load; the first stop is the skip link.
    await page.reload({ waitUntil: 'networkidle' });
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    const ringLive = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return { ok: false, why: 'nothing took focus on Tab' };
        if (!a.matches(':focus-visible')) return { ok: false, why: `${a.tagName} did not match :focus-visible` };
        const cs = getComputedStyle(a);
        const w = parseFloat(cs.outlineWidth) || 0;
        return (w >= 1 && cs.outlineStyle !== 'none')
            ? { ok: true }
            : { ok: false, why: `${a.tagName} focused with outline "${cs.outline}"` };
    });
    if (!ringLive.ok) {
        console.log(`  [2.4.7] no visible keyboard focus indicator: ${ringLive.why}`);
        total += 1;
    }

    await page.locator('#tab-gallery').click();
    await page.waitForTimeout(300);
    await capture('gallery');

    await page.locator('#tab-docs').click();
    await page.waitForTimeout(300);
    await capture('docs');

    // Worst case per selector across every state.
    const worst = new Map();
    for (const [state, rows] of states) {
        for (const r of rows) {
            const key = `${r.rule} ${r.sel}`;
            if (!worst.has(key) || worst.get(key).got > r.got) worst.set(key, { ...r, state });
        }
    }
    const rows = [...worst.values()].sort((a, b) => a.got - b.got);
    total += rows.length;

    console.log(`\n${theme.toUpperCase()}: ${rows.length ? `${rows.length} AA failure(s)` : 'pass'}`);
    for (const r of rows) {
        console.log(`  ${String(r.got).padStart(5)} < ${r.need}  [${r.rule}] ${r.sel}  (${r.state})`);
        console.log(`         ${r.detail}${r.text ? `  "${r.text}"` : ''}`);
    }

    await ctx.close();
}

await browser.close();
console.log(total ? `\n✗ ${total} contrast failure(s)` : '\n✓ WCAG AA: no contrast failures in either theme');
process.exit(total ? 1 : 0);
