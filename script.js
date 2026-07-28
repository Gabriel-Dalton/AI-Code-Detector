/* AI Code Detector — the UI layer.
 *
 * Everything that touches the DOM, localStorage or the user lives here. The
 * detection itself is in `detector.js`, which this file expects to have been
 * loaded first (see the script tags at the bottom of index.html) and which
 * knows nothing about any of this.
 *
 * The split is what makes the engine testable: `test/` requires detector.js
 * directly under Node, with no DOM and no headless browser involved.
 */

// ---------- thresholds ----------

/* The only DOM-aware half of scoring: read what the two number inputs hold and
   hand it to the engine's pure normaliser. Empty or non-numeric input falls
   back to the defaults rather than scoring against NaN. */
function readThresholds() {
    return normaliseThresholds({
        mixed: parseInt(document.getElementById('thresholdMixed')?.value, 10),
        ai: parseInt(document.getElementById('thresholdAi')?.value, 10)
    });
}

// ---------- rendering ----------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Rows shown before the "show all" affordance kicks in.
const EVIDENCE_PREVIEW = 5;

function renderVerdict(agg) {
    const t = agg.thresholds;
    const pct = agg.percentage;
    const tone = `tone-${agg.verdict.tone}`;

    // Threshold labels are positioned at their true percentage; skip the ones
    // that would collide with the 0 / 100 end caps.
    const mark = (value) => (value < 7 || value > 93)
        ? ''
        : `<span class="meter-mark meter-mark--tick" style="left:${value}%">${value}</span>`;

    return `
        <div class="verdict">
            <div class="verdict-row">
                <span class="tag ${tone}">${escapeHtml(agg.verdict.label)}</span>
                <span class="verdict-score">${pct.toFixed(1)}<span class="unit">%</span></span>
            </div>
            <div class="meter">
                <div class="meter-track" role="img"
                     aria-label="Score ${pct.toFixed(1)} out of 100, mixed threshold ${t.mixed}, AI threshold ${t.ai}">
                    <div class="meter-fill ${tone}" style="width:${pct.toFixed(2)}%"></div>
                    <span class="meter-tick" style="left:${t.mixed}%"></span>
                    <span class="meter-tick" style="left:${t.ai}%"></span>
                </div>
                <div class="meter-scale" aria-hidden="true">
                    <span class="meter-mark meter-mark--start">0 · human</span>
                    ${mark(t.mixed)}${mark(t.ai)}
                    <span class="meter-mark meter-mark--end">ai · 100</span>
                </div>
            </div>
            <p class="verdict-note">${agg.sumMatched.toFixed(2)} of ${agg.sumMax.toFixed(2)} weight matched · thresholds ${t.mixed}/${t.ai}</p>
        </div>
    `;
}

function renderFinding(f) {
    const sign = f.weight < 0 ? '−' : '+';
    const tone = f.weight < 0 ? 'human' : 'ai';
    const lines = f.evidence.map(e => e.line).filter(Boolean);
    const linesAttr = lines.length ? ` data-lines="${lines.join(',')}"` : '';
    const overflow = Math.max(0, f.evidence.length - EVIDENCE_PREVIEW);

    const rows = f.evidence.map((e, i) => {
        const hide = i >= EVIDENCE_PREVIEW ? ' hidden' : '';
        const label = e.line ? `L${e.line}` : '·';
        return `<li class="evidence-item${hide}"><button type="button" class="evidence-row" data-line="${e.line || 0}">` +
               `<span class="line-num">${label}</span><span class="snippet">${escapeHtml(e.snippet)}</span>` +
               `</button></li>`;
    }).join('');

    const moreBtn = overflow
        ? `<button type="button" class="btn btn-quiet evidence-more" data-expanded="false">Show ${overflow} more</button>`
        : '';

    return `
        <details class="finding" data-tone="${tone}"${linesAttr} open>
            <summary>
                <span class="tag tone-${tone}">${tone === 'human' ? 'human' : 'ai'}</span>
                <span class="finding-label">${escapeHtml(f.label)}</span>
                <span class="finding-weight">${sign}${Math.abs(f.weight).toFixed(1)}</span>
            </summary>
            <div class="finding-body">
                <p class="finding-reason">${escapeHtml(f.reason)}</p>
                ${f.evidence.length ? `<ul class="evidence">${rows}</ul>${moreBtn}` : ''}
            </div>
        </details>
    `;
}

function renderResults(findings, agg) {
    document.getElementById('results-empty')?.classList.add('hidden');

    const matched = findings.filter(f => f.matched);
    const unmatched = findings.filter(f => !f.matched);

    document.getElementById('result-summary').innerHTML = renderVerdict(agg);

    const list = document.getElementById('result-findings');
    list.innerHTML = `
        <h3 class="findings-heading">Matched signals <span class="count">${matched.length} of ${findings.length}</span></h3>
        ${matched.map(renderFinding).join('') || '<p class="empty-rule">nothing matched</p>'}
        <details class="unmatched">
            <summary><span class="caret" aria-hidden="true">▸</span> Not matched <span class="count">${unmatched.length}</span></summary>
            <ul class="unmatched-list">
                ${unmatched.map(f => `<li>${escapeHtml(f.label)}</li>`).join('')}
            </ul>
        </details>
    `;

    wireFindingInteractions(list);

    const status = document.getElementById('result-status');
    if (status) {
        status.textContent = `${agg.verdict.label}. Score ${agg.percentage.toFixed(1)} percent. ` +
                             `${matched.length} of ${findings.length} signals matched.`;
    }
}

function wireFindingInteractions(root) {
    root.querySelectorAll('.evidence-row').forEach(el => {
        const line = parseInt(el.dataset.line, 10);
        if (!(line > 0)) return;
        el.addEventListener('click', () => jumpTextareaToLine(line));
        el.addEventListener('mouseenter', () => highlightEditorLines([line], true));
        el.addEventListener('mouseleave', () => highlightEditorLines([line], false));
        el.addEventListener('focus', () => highlightEditorLines([line], true));
        el.addEventListener('blur', () => highlightEditorLines([line], false));
    });

    // Hover a whole finding => light up every line it cites.
    root.querySelectorAll('.finding[data-lines]').forEach(el => {
        const lines = el.dataset.lines.split(',').map(Number).filter(Boolean);
        el.addEventListener('mouseenter', () => highlightEditorLines(lines, true));
        el.addEventListener('mouseleave', () => highlightEditorLines(lines, false));
    });

    root.querySelectorAll('.evidence-more').forEach(btn => {
        btn.addEventListener('click', () => {
            const items = [...btn.previousElementSibling.querySelectorAll('.evidence-item')];
            const expanded = btn.dataset.expanded === 'true';
            const hiddenCount = items.length - EVIDENCE_PREVIEW;
            items.forEach((li, i) => li.classList.toggle('hidden', expanded && i >= EVIDENCE_PREVIEW));
            btn.dataset.expanded = String(!expanded);
            btn.textContent = expanded ? `Show ${hiddenCount} more` : 'Show fewer';
        });
    });
}

function jumpTextareaToLine(line) {
    const ta = document.getElementById('inputCode');
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
        pos += lines[i].length + 1;
    }
    const end = pos + (lines[line - 1] || '').length;
    ta.focus();
    ta.setSelectionRange(pos, end);
}

// ---------- top-level handlers ----------

function clearResults() {
    document.getElementById('result-summary').innerHTML = '';
    document.getElementById('result-findings').innerHTML = '';
    document.getElementById('results-empty')?.classList.remove('hidden');
    const status = document.getElementById('result-status');
    if (status) status.textContent = '';
}

function analyzeCode() {
    const code = document.getElementById('inputCode').value;
    if (code.trim() === '') {
        clearResults();
        return;
    }
    const findings = runHeuristics(code);
    renderResults(findings, aggregate(findings, readThresholds()));
    persistState();
}

function resetForm() {
    document.getElementById('inputCode').value = '';
    clearResults();
    updateEditorChrome();
    exampleCombo?.reset();
    persistState();
}

// ---------- gallery ----------

const GALLERY_CLIP_LINES = 16;

function renderGallery() {
    const grid = document.getElementById('gallery-grid');
    if (!grid) return;
    const examples = window.AI_CODE_EXAMPLES || [];

    grid.innerHTML = examples.map(ex => {
        const lines = ex.code.split('\n');
        const codeLines = lines.map((l, i) => {
            const ln = i + 1;
            return `<span class="code-line" data-line="${ln}">` +
                   `<span class="code-line-num">${ln}</span>${escapeHtml(l) || ' '}</span>`;
        }).join('');

        const clipped = lines.length > GALLERY_CLIP_LINES;
        const expand = clipped
            ? `<button type="button" class="code-expand" data-expanded="false">Show all ${lines.length} lines</button>`
            : '';

        const annotations = ex.annotations.map(a => {
            const [from, to] = a.lineRange;
            const range = from === to ? `L${from}` : `L${from}–${to}`;
            // An annotation can describe a tell this detector doesn't score
            // (see the note in examples.js). Say so on the card rather than
            // letting the row imply a match the analyzer won't reproduce.
            const unscored = a.scored === false
                ? '<span class="annotation-unscored">not scored</span>'
                : '';
            return `<li class="annotation${a.scored === false ? ' is-unscored' : ''}"
                        data-from="${from}" data-to="${to}" data-card="${ex.id}">
                        <span class="annotation-range">${range}</span>
                        <span class="annotation-signal">${escapeHtml(a.signal)}${unscored}</span>
                        <span class="annotation-why">${escapeHtml(a.why)}</span>
                    </li>`;
        }).join('');

        const verbatim = ex.provenance === 'verbatim';
        return `
            <article class="card" data-id="${escapeHtml(ex.id)}" data-language="${escapeHtml(ex.language)}">
                <header class="card-head">
                    <h3>${escapeHtml(ex.title)}</h3>
                    <div class="card-badges">
                        <span class="badge badge-lang">${escapeHtml(ex.language)}</span>
                        <span class="badge${verbatim ? ' badge-verbatim' : ''}">${escapeHtml(ex.provenance)} · ${escapeHtml(ex.sourceLabel)}</span>
                    </div>
                </header>
                <p class="card-blurb">${escapeHtml(ex.blurb)}</p>
                <div class="code-well${clipped ? ' is-clipped' : ''}">
                    <pre><code>${codeLines}</code></pre>
                    ${expand}
                </div>
                <h4 class="annotations-heading">Why this looks AI-generated</h4>
                <ul class="annotations">${annotations}</ul>
                <div class="card-foot">
                    <button type="button" class="btn" data-load="${escapeHtml(ex.id)}">Load into analyzer</button>
                </div>
            </article>
        `;
    }).join('');

    grid.querySelectorAll('[data-load]').forEach(btn => {
        btn.addEventListener('click', () => loadExampleIntoAnalyzer(btn.dataset.load));
    });

    grid.querySelectorAll('.annotation').forEach(li => {
        const args = [li.dataset.card, +li.dataset.from, +li.dataset.to];
        li.addEventListener('mouseenter', () => highlightCardLines(...args, true));
        li.addEventListener('mouseleave', () => highlightCardLines(...args, false));
    });

    grid.querySelectorAll('.code-expand').forEach(btn => {
        btn.addEventListener('click', () => {
            const well = btn.closest('.code-well');
            const expanded = btn.dataset.expanded === 'true';
            well.classList.toggle('is-clipped', expanded);
            btn.dataset.expanded = String(!expanded);
            btn.textContent = expanded
                ? `Show all ${well.querySelectorAll('.code-line').length} lines`
                : 'Collapse';
        });
    });
}

function highlightCardLines(cardId, from, to, on) {
    const card = document.querySelector(`.card[data-id="${cardId}"]`);
    if (!card) return;
    // Expand the preview so a cited line can't be highlighted out of view.
    if (on && card.querySelector('.code-well.is-clipped') && to > GALLERY_CLIP_LINES) {
        card.querySelector('.code-expand')?.click();
    }
    card.querySelectorAll('.code-line').forEach(el => {
        const ln = parseInt(el.dataset.line, 10);
        el.classList.toggle('is-lit', on && ln >= from && ln <= to);
    });
}

function loadExampleIntoAnalyzer(id) {
    const ex = (window.AI_CODE_EXAMPLES || []).find(e => e.id === id);
    if (!ex) return;
    const ta = document.getElementById('inputCode');
    ta.value = ex.code;
    ta.scrollTop = 0;
    ta.setSelectionRange(0, 0);
    switchTab('analyze');
    updateEditorChrome();
    analyzeCode();
    document.getElementById('panel-analyze').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- filter chips ----------

function setupFilters() {
    const chips = [...document.querySelectorAll('.filters .chip')];
    const empty = document.getElementById('gallery-empty');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => {
                const on = c === chip;
                c.classList.toggle('is-active', on);
                c.setAttribute('aria-pressed', String(on));
            });
            const filter = chip.dataset.filter;
            let shown = 0;
            document.querySelectorAll('.card[data-language]').forEach(card => {
                const hide = filter !== 'all' && card.dataset.language !== filter;
                card.classList.toggle('hidden', hide);
                if (!hide) shown++;
            });
            empty?.classList.toggle('hidden', shown > 0);
        });
    });
}

// ---------- heuristics tab ----------

function renderDocs() {
    const list = document.getElementById('docs-list');
    if (!list) return;
    list.innerHTML = HEURISTICS.map(h => {
        const human = h.weight < 0;
        const sign = human ? '−' : '+';
        return `
            <article class="doc-row">
                <header>
                    <h3>${escapeHtml(h.label)}</h3>
                    <span class="doc-weight">${sign}${Math.abs(h.weight).toFixed(1)}</span>
                </header>
                <p class="doc-desc">
                    <span class="tag ${human ? 'tone-human' : 'tone-ai'}">${human ? 'human' : 'ai'}</span>
                    ${escapeHtml(h.about)}
                </p>
                <code class="doc-id">${escapeHtml(h.id)}</code>
            </article>
        `;
    }).join('');
}

// ---------- tabs ----------

function switchTab(name) {
    document.querySelectorAll('[role="tab"]').forEach(tab => {
        const active = tab.dataset.tab === name;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.hidden = panel.id !== `panel-${name}`;
    });
}

function setupTabs() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        tab.addEventListener('keydown', (e) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            const jump = { Home: 0, End: tabs.length - 1 }[e.key];
            const next = step !== undefined ? tabs[(i + step + tabs.length) % tabs.length]
                       : jump !== undefined ? tabs[jump]
                       : null;
            if (!next) return;
            e.preventDefault();
            switchTab(next.dataset.tab);
            next.focus();
        });
    });
}

// ---------- combobox ----------

/* An ARIA combobox/listbox. A native <select> paints its open list with OS
   chrome, which no amount of CSS can reach; this keeps the open state inside
   the design while preserving the keyboard contract people expect from a
   select: Enter/Space/Arrow to open, arrows to move, Enter to choose, Escape
   to dismiss, and type-ahead. */
function createCombobox({ root, items, placeholder, onSelect }) {
    if (!root) return null;

    const button = root.querySelector('.combo-button');
    const value = root.querySelector('.combo-value');
    const list = root.querySelector('.combo-list');
    const listId = list.id;

    let activeIndex = -1;
    let selectedIndex = -1;
    let typeahead = '';
    let typeaheadTimer = 0;

    list.innerHTML = items.map((item, i) => `
        <li class="combo-option" role="option" id="${listId}-opt-${i}"
            data-index="${i}" aria-selected="false">
            <span class="combo-option-label">${escapeHtml(item.label)}</span>
            ${item.meta ? `<span class="combo-option-meta">${escapeHtml(item.meta)}</span>` : ''}
        </li>`).join('');

    const options = [...list.querySelectorAll('.combo-option')];
    const isOpen = () => button.getAttribute('aria-expanded') === 'true';

    function setActive(index, { scroll = true } = {}) {
        activeIndex = index;
        options.forEach((el, i) => el.classList.toggle('is-active', i === index));
        if (index < 0) {
            button.removeAttribute('aria-activedescendant');
            return;
        }
        button.setAttribute('aria-activedescendant', options[index].id);
        if (scroll) options[index].scrollIntoView({ block: 'nearest' });
    }

    function open() {
        if (isOpen()) return;
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        setActive(selectedIndex >= 0 ? selectedIndex : 0);
    }

    function close({ focusButton = false } = {}) {
        if (!isOpen()) return;
        list.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        setActive(-1);
        if (focusButton) button.focus();
    }

    function choose(index) {
        const item = items[index];
        if (!item) return;
        selectedIndex = index;
        options.forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
        value.textContent = item.label;
        close({ focusButton: true });
        onSelect(item, index);
    }

    function move(delta) {
        if (!options.length) return;
        const from = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
        setActive((from + delta + options.length) % options.length);
    }

    function jumpToTypeahead(char) {
        window.clearTimeout(typeaheadTimer);
        typeahead += char.toLowerCase();
        typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 700);
        const hit = items.findIndex(item => item.label.toLowerCase().startsWith(typeahead));
        if (hit >= 0) setActive(hit);
    }

    button.addEventListener('click', () => (isOpen() ? close() : open()));

    button.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                isOpen() ? move(1) : open();
                break;
            case 'ArrowUp':
                e.preventDefault();
                isOpen() ? move(-1) : open();
                break;
            case 'Home':
                if (!isOpen()) break;
                e.preventDefault();
                setActive(0);
                break;
            case 'End':
                if (!isOpen()) break;
                e.preventDefault();
                setActive(options.length - 1);
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                isOpen() && activeIndex >= 0 ? choose(activeIndex) : open();
                break;
            case 'Escape':
                if (!isOpen()) break;
                e.preventDefault();
                close();
                break;
            case 'Tab':
                close();
                break;
            default:
                if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    if (!isOpen()) open();
                    jumpToTypeahead(e.key);
                }
        }
    });

    options.forEach((el, i) => {
        el.addEventListener('click', () => choose(i));
        el.addEventListener('mousemove', () => {
            if (activeIndex !== i) setActive(i, { scroll: false });
        });
    });

    document.addEventListener('pointerdown', (e) => {
        if (!root.contains(e.target)) close();
    });

    if (placeholder) value.textContent = placeholder;

    return {
        reset() {
            selectedIndex = -1;
            options.forEach(el => el.setAttribute('aria-selected', 'false'));
            if (placeholder) value.textContent = placeholder;
        }
    };
}

let exampleCombo = null;

function setupExampleCombo() {
    const examples = window.AI_CODE_EXAMPLES || [];
    exampleCombo = createCombobox({
        root: document.getElementById('exampleCombo'),
        placeholder: 'Load an example',
        items: examples.map(e => ({ value: e.id, label: e.title, meta: e.language })),
        onSelect: (item) => loadExampleIntoAnalyzer(item.value)
    });
}

// ---------- editor (line-numbered gutter + hover-highlight overlay) ----------

function updateEditorChrome() {
    const ta = document.getElementById('inputCode');
    const gutter = document.getElementById('editor-gutter');
    const overlay = document.getElementById('editor-overlay');
    const count = document.getElementById('editor-count');
    if (!ta) return;

    const lines = ta.value.split('\n');
    if (gutter) {
        gutter.textContent = lines.map((_, i) => i + 1).join('\n');
    }
    if (overlay) {
        overlay.innerHTML = lines
            .map((_, i) => `<span class="ovl-line" data-line="${i + 1}">&nbsp;</span>`)
            .join('');
    }
    if (count) {
        const n = ta.value === '' ? 0 : lines.length;
        const chars = ta.value.length;
        count.textContent = `${n} ${n === 1 ? 'line' : 'lines'} · ${chars.toLocaleString('en-US')} chars`;
    }
    syncEditorScroll();
}

function syncEditorScroll() {
    const ta = document.getElementById('inputCode');
    const gutter = document.getElementById('editor-gutter');
    const overlay = document.getElementById('editor-overlay');
    if (!ta) return;
    if (gutter) gutter.scrollTop = ta.scrollTop;
    if (overlay) {
        overlay.scrollTop = ta.scrollTop;
        overlay.scrollLeft = 0;
    }
}

function highlightEditorLines(lines, on) {
    const overlay = document.getElementById('editor-overlay');
    if (!overlay) return;
    lines.forEach(ln => {
        overlay.querySelector(`.ovl-line[data-line="${ln}"]`)?.classList.toggle('is-hl', !!on);
    });
}

function setupEditor() {
    const ta = document.getElementById('inputCode');
    if (!ta) return;
    ta.addEventListener('input', () => {
        updateEditorChrome();
        persistState();
    });
    ta.addEventListener('scroll', syncEditorScroll);
    ta.addEventListener('keydown', (e) => {
        // Cmd/Ctrl + Enter => analyze
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            analyzeCode();
            return;
        }
        // Tab inserts an indent instead of leaving the field. Shift+Tab still
        // moves focus, so the editor never becomes a keyboard trap.
        if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const { selectionStart: start, selectionEnd: end } = ta;
            ta.value = ta.value.slice(0, start) + '    ' + ta.value.slice(end);
            ta.selectionStart = ta.selectionEnd = start + 4;
            updateEditorChrome();
        }
    });
    updateEditorChrome();
}

// ---------- theme ----------

const THEME_KEY = 'ai-code-detector:theme';

function effectiveTheme() {
    const explicit = document.documentElement.dataset.theme;
    if (explicit === 'light' || explicit === 'dark') return explicit;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function setupTheme() {
    const btn = document.getElementById('themeToggle');
    const label = document.getElementById('themeToggleLabel');
    if (!btn) return;

    const sync = () => {
        const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
        if (label) label.textContent = next === 'dark' ? 'Dark theme' : 'Light theme';
        btn.setAttribute('aria-label', `Switch to the ${next} theme`);
    };

    btn.addEventListener('click', () => {
        const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private mode */ }
        sync();
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
    sync();
}

// ---------- persistence ----------

const LS_KEY = 'ai-code-detector:v1';

function persistState() {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            code: document.getElementById('inputCode')?.value || '',
            mixed: document.getElementById('thresholdMixed')?.value || String(DEFAULT_THRESHOLDS.mixed),
            ai: document.getElementById('thresholdAi')?.value || String(DEFAULT_THRESHOLDS.ai)
        }));
    } catch (_) { /* private mode; persistence is a nicety, not a requirement */ }
}

function restoreState() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        const ta = document.getElementById('inputCode');
        if (ta && typeof s.code === 'string') ta.value = s.code;
        const m = document.getElementById('thresholdMixed');
        const a = document.getElementById('thresholdAi');
        if (m && s.mixed) m.value = s.mixed;
        if (a && s.ai) a.value = s.ai;
    } catch (_) { /* ignore malformed state */ }
}

function setupThresholds() {
    ['thresholdMixed', 'thresholdAi'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            persistState();
            // Re-score in place if a verdict is already on screen.
            if (document.querySelector('#result-summary .verdict-score')) analyzeCode();
        });
    });
}

// ---------- init ----------

function init() {
    restoreState();
    setupTheme();
    setupTabs();
    setupExampleCombo();
    setupFilters();
    setupEditor();
    setupThresholds();
    renderGallery();
    renderDocs();

    document.getElementById('analyzeBtn').addEventListener('click', analyzeCode);
    document.getElementById('resetBtn').addEventListener('click', resetForm);

    const examples = window.AI_CODE_EXAMPLES || [];
    const counts = {
        'meta-signals': HEURISTICS.length,
        'tab-count-docs': HEURISTICS.length,
        'meta-examples': examples.length,
        'tab-count-gallery': examples.length,
        'meta-languages': new Set(examples.map(e => e.language)).size
    };
    Object.entries(counts).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
