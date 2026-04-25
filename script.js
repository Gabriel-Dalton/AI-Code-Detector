/* AI Code Detector
 *
 * Each heuristic is a function that returns a Finding:
 *   { id, label, matched, weight, maxWeight, reason, evidence:[{line,snippet}] }
 *
 * The aggregator clamps the score to 0..100 and renders per-signal evidence
 * (line numbers + snippets) so the user can see WHY each signal fired.
 */

// ---------- helpers ----------

function splitLines(code) {
    return code.split('\n');
}

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

// Replace string-literal contents with a placeholder so regexes don't match
// inside strings. Preserves length so line/column references still line up.
function stripStrings(code) {
    return code.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0]);
}

function looksLikePython(code) {
    return /^\s*(def |class |import |from )/m.test(code) ||
           /:\s*$/m.test(code) && !/[{};]/.test(code.slice(0, 200));
}

function looksLikeJavaOrTs(code) {
    return /\b(public|private|interface|implements|extends)\b/.test(code) ||
           /:\s*\w+\s*[=,)]/.test(code); // crude TS type-annotation sniff
}

// Returns the set of line numbers (1-indexed) that are comments.
function commentLineSet(code) {
    const stripped = stripStrings(code);
    const lines = splitLines(stripped);
    const set = new Set();
    let inBlock = false;
    lines.forEach((line, i) => {
        const ln = i + 1;
        const trimmed = line.trim();
        if (inBlock) {
            set.add(ln);
            if (trimmed.includes('*/')) inBlock = false;
            return;
        }
        if (trimmed.startsWith('/*')) {
            set.add(ln);
            if (!trimmed.includes('*/')) inBlock = true;
            return;
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
            set.add(ln);
        }
    });
    return set;
}

function snippet(line, max = 80) {
    const t = line.replace(/\s+$/, '');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------- heuristics ----------

function checkFormattingTooClean(code) {
    const lines = splitLines(code);
    const indented = lines
        .map((l, i) => ({ l, i: i + 1, indent: (l.match(/^[ \t]*/) || [''])[0] }))
        .filter(x => x.l.trim() !== '' && x.indent.length > 0);

    const reason = "Indentation is uniform with no trailing whitespace and no mixed tabs/spaces - a 'too tidy' tell.";
    if (indented.length < 4 || lines.length < 12) {
        return { matched: false, evidence: [], reason };
    }

    const usesTabs = indented.some(x => x.indent.includes('\t'));
    const usesSpaces = indented.some(x => / /.test(x.indent));
    const mixed = usesTabs && usesSpaces;

    const stepCounts = {};
    indented.forEach(x => {
        const len = x.indent.replace(/\t/g, '    ').length;
        stepCounts[len] = (stepCounts[len] || 0) + 1;
    });
    const lengths = Object.keys(stepCounts).map(Number).sort((a, b) => a - b);
    const gcdAll = lengths.reduce((a, b) => {
        const g = (x, y) => y === 0 ? x : g(y, x % y);
        return g(a, b);
    }, lengths[0] || 0);
    const cleanStep = gcdAll === 2 || gcdAll === 4;

    const trailingWs = lines.some(l => / +$/.test(l));

    const matched = !mixed && cleanStep && !trailingWs;
    const evidence = matched
        ? indented.slice(0, 3).map(x => ({ line: x.i, snippet: snippet(x.l) }))
        : [];
    return { matched, evidence, reason };
}

function checkGenericNames(code) {
    const generic = ['data', 'result', 'output', 'input', 'value', 'temp', 'item', 'payload', 'obj', 'arr', 'helper'];
    const stripped = stripStrings(code);
    const lines = splitLines(stripped);
    const evidence = [];
    const re = new RegExp(`\\b(${generic.join('|')})\\b`, 'g');
    lines.forEach((l, i) => {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(l)) !== null) {
            evidence.push({ line: i + 1, snippet: `${m[1]}  -  ${snippet(l.trim(), 70)}` });
            if (evidence.length >= 6) break;
        }
        if (evidence.length >= 6) return;
    });
    return {
        matched: evidence.length >= 2,
        evidence,
        reason: "Uses generic placeholder identifiers like 'data', 'result', 'value' rather than domain-specific names."
    };
}

function checkLackOfComments(code) {
    const lines = splitLines(code);
    const codeLines = lines.filter(l => l.trim() !== '').length;
    const commentLines = commentLineSet(code).size;
    const matched = codeLines >= 25 && commentLines === 0;
    return {
        matched,
        evidence: matched ? [{ line: 0, snippet: `0 comment lines across ${codeLines} non-empty lines` }] : [],
        reason: "Body has no comments at all despite being long enough that a human author would usually leave at least one."
    };
}

function checkRepetitiveLines(code) {
    const lines = splitLines(code).map(l => l.trim()).filter(l => l !== '');
    if (lines.length < 8) {
        return { matched: false, evidence: [], reason: "Many lines are duplicated verbatim - a sign of copy-paste structure." };
    }
    const buckets = {};
    lines.forEach((l, i) => {
        if (l.length < 4) return;
        if (!buckets[l]) buckets[l] = [];
        buckets[l].push(i + 1);
    });
    const dupes = Object.entries(buckets).filter(([, v]) => v.length >= 2);
    const totalDupLines = dupes.reduce((acc, [, v]) => acc + v.length, 0);
    const ratio = totalDupLines / lines.length;
    const evidence = dupes
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 3)
        .map(([text, nums]) => ({ line: nums[0], snippet: `x${nums.length} (lines ${nums.join(', ')}): ${snippet(text, 60)}` }));
    const heaviest = Math.max(0, ...dupes.map(([, v]) => v.length));
    const matched = (ratio > 0.20 && dupes.length >= 2) || heaviest >= 4;
    return {
        matched,
        evidence,
        reason: "Many lines are duplicated verbatim - a sign of copy-paste structure."
    };
}

function checkOverStructured(code) {
    const lines = splitLines(code);
    const evidence = [];
    const re = /\b(if|for|while|switch)\s*\(/g;
    let total = 0;
    lines.forEach((l, i) => {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(l)) !== null) {
            total++;
            if (evidence.length < 5) {
                evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
            }
        }
    });
    const matched = total > 5;
    return {
        matched,
        evidence: matched ? evidence : [],
        reason: `Many control-flow blocks (${total} matched) packed into the snippet - suggests a copy-pasted scaffold rather than an organic implementation.`
    };
}

function checkHumanComplexity(code) {
    const lineCount = splitLines(code).filter(l => l.trim() !== '').length;
    const kw = code.match(/\b(?:if|else|for|while|switch|return|function|const|let|var|class|try|catch|throw|async|await|yield)\b/g) || [];
    const unique = new Set(kw);
    const matched = unique.size > 10 && lineCount > 20;
    return {
        matched,
        evidence: matched ? [{ line: 0, snippet: `${unique.size} distinct control keywords across ${lineCount} lines` }] : [],
        reason: "Wide variety of language features in use - human authors mix idioms; LLMs tend to stick to a small subset."
    };
}

function checkOverCommenting(code) {
    const lines = splitLines(code);
    const codeLines = lines.filter(l => l.trim() !== '').length;
    const comments = commentLineSet(code);
    if (codeLines < 8 || comments.size === 0) {
        return { matched: false, evidence: [], reason: "Almost every statement is shadowed by a comment that restates it." };
    }

    const evidence = [];
    let trivialPairs = 0;
    lines.forEach((l, i) => {
        const ln = i + 1;
        if (!comments.has(ln)) return;
        // Look at the next non-empty, non-comment line.
        for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j];
            if (next.trim() === '') continue;
            if (comments.has(j + 1)) break;
            if (next.trim().length <= 30) {
                trivialPairs++;
                if (evidence.length < 5) {
                    evidence.push({ line: ln, snippet: `${snippet(l.trim(), 50)}  →  ${snippet(next.trim(), 40)}` });
                }
            }
            break;
        }
    });
    const ratio = comments.size / Math.max(1, codeLines);
    const matched = ratio > 0.5 || trivialPairs >= 4;
    return {
        matched,
        evidence: matched ? evidence : [],
        reason: "Almost every statement is shadowed by a comment that restates it."
    };
}

function checkPreambleStrings(code) {
    const lines = splitLines(code).slice(0, 6);
    const re = /^\s*(?:#|\/\/|\/\*+|"""|'''|<!--)?\s*(here(?:'s| is)|sure[,!]|certainly[,!]|of course|let me|i'll|below is|the following|in this (?:example|snippet))\b/i;
    const evidence = [];
    lines.forEach((l, i) => {
        const m = l.match(re);
        if (m) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
    });
    return {
        matched: evidence.length > 0,
        evidence,
        reason: "Code begins with a conversational preamble ('Here's...', 'Below is...') - a giveaway from chat-style LLM output."
    };
}

function checkExcessiveTryExcept(code) {
    const stripped = stripStrings(code);
    const lines = splitLines(stripped);
    const evidence = [];

    let bareOrBroad = 0;
    lines.forEach((l, i) => {
        if (/^\s*except\s*(Exception|BaseException)?\s*(as\s+\w+)?\s*:/.test(l)) {
            bareOrBroad++;
            if (evidence.length < 5) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
        }
        if (/}\s*catch\s*\(\s*\w*\s*\)\s*\{\s*$/.test(l) || /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(l)) {
            bareOrBroad++;
            if (evidence.length < 5) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
        }
    });

    // Count try blocks with a single statement body (Python-ish).
    let singleStmtTry = 0;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*try\s*:\s*$/.test(lines[i])) {
            const indent = (lines[i].match(/^\s*/) || [''])[0].length;
            const body = [];
            for (let j = i + 1; j < lines.length; j++) {
                const b = lines[j];
                if (b.trim() === '') continue;
                const bIndent = (b.match(/^\s*/) || [''])[0].length;
                if (bIndent <= indent) break;
                body.push(b);
            }
            if (body.length === 1) {
                singleStmtTry++;
                if (evidence.length < 5) evidence.push({ line: i + 1, snippet: 'try: with single-statement body' });
            }
        }
    }

    const matched = bareOrBroad >= 2 || singleStmtTry >= 2;
    return {
        matched,
        evidence: matched ? evidence : [],
        reason: "Multiple broad try/except (or empty catch) blocks - 'safe by default' overcorrection common in LLM output."
    };
}

function checkJsdocOnEverything(code) {
    const stripped = code; // we want to see /** */ as-is
    // Count function declarations, arrow assignments, methods, constructors.
    const patterns = [
        /\bfunction\s+\w+\s*\(/g,
        /\b\w+\s*=\s*\([^)]*\)\s*=>/g,
        /\b\w+\s*:\s*function\b/g,
        /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:[\w<>?\[\],\s]+\s+)?\w+\s*\([^)]*\)\s*(?:\{|throws)/gm
    ];
    let funcCount = 0;
    patterns.forEach(re => { funcCount += (stripped.match(re) || []).length; });
    const jsdocBlocks = (stripped.match(/\/\*\*[\s\S]*?\*\//g) || []).length;
    const matched = funcCount >= 2 && jsdocBlocks >= Math.max(2, funcCount * 0.8);
    const lines = splitLines(stripped);
    const evidence = [];
    lines.forEach((l, i) => {
        if (/^\s*\/\*\*/.test(l) && evidence.length < 4) {
            evidence.push({ line: i + 1, snippet: 'JSDoc block opens here' });
        }
    });
    return {
        matched,
        evidence: matched ? evidence.concat([{ line: 0, snippet: `${jsdocBlocks} JSDoc blocks for ${funcCount} functions` }]) : [],
        reason: "Almost every function has a full JSDoc block, including one-liners that don't need one."
    };
}

function checkDefensiveNullChecks(code) {
    const stripped = stripStrings(code);
    const lines = splitLines(stripped);
    const evidence = [];
    let guardCount = 0;
    const guarded = new Set();
    const ACCESS = '(\\w+(?:\\??\\.\\w+)*)';
    const patterns = [
        new RegExp(`\\bif\\s*\\(\\s*${ACCESS}\\s*===?\\s*(?:null|undefined)\\s*\\)`),
        new RegExp(`\\bif\\s*\\(\\s*${ACCESS}\\s*!==?\\s*(?:null|undefined)\\s*\\)`),
        new RegExp(`\\bif\\s*\\(\\s*!\\s*${ACCESS}\\s*\\)`),
        /\bif\s+(\w+)\s+is\s+None\b/,
        /\bif\s+(\w+)\s+is\s+not\s+None\b/,
        /\bif\s+not\s+(\w+)\s*[:)]/,
        new RegExp(`\\bif\\s*\\(\\s*${ACCESS}\\s*==\\s*null\\s*\\)`),
        /\bthrow\s+new\s+IllegalArgumentException\s*\(/
    ];
    lines.forEach((l, i) => {
        for (const re of patterns) {
            const m = l.match(re);
            if (m) {
                if (m[1]) guarded.add(m[1]);
                guardCount++;
                if (evidence.length < 5) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
                break;
            }
        }
    });
    const codeLines = lines.filter(l => l.trim() !== '').length;
    const density = guardCount / Math.max(1, codeLines);
    const matched = (guarded.size >= 3 || guardCount >= 5) && density >= 0.08;
    return {
        matched,
        evidence: matched ? evidence : [],
        reason: "Many null/None/undefined guards on values whose contracts already exclude those - defensive overcorrection."
    };
}

function checkSymmetricHelperNames(code) {
    const stripped = stripStrings(code);
    const lines = splitLines(stripped);

    // Collect function/def names AND track whether each is a one-liner (body fits on the same line or next line is a single return/expression).
    const fnRe = /\b(?:function|def)\s+(\w+)\s*\(/;
    const named = [];
    lines.forEach((l, i) => {
        const m = l.match(fnRe);
        if (m) named.push({ name: m[1], line: i + 1 });
    });
    if (named.length < 3) {
        return { matched: false, evidence: [], reason: "Several helpers share an LLM-favoured verb prefix, noun suffix, or are textbook one-liner siblings." };
    }
    const evidence = [];
    const names = named.map(x => x.name);

    const verbs = ['process', 'handle', 'format', 'validate', 'parse', 'compute', 'transform', 'sanitize', 'extract', 'build', 'get', 'set'];
    const prefixClusters = {};
    names.forEach(n => {
        for (const v of verbs) {
            if (n.toLowerCase().startsWith(v) && n.length > v.length) {
                prefixClusters[v] = prefixClusters[v] || [];
                prefixClusters[v].push(n);
                break;
            }
        }
    });
    Object.entries(prefixClusters).forEach(([v, ns]) => {
        if (ns.length >= 3) evidence.push({ line: 0, snippet: `${v}*: ${ns.join(', ')}` });
    });

    // Suffix clusters
    const suffixCounts = {};
    names.forEach(n => {
        const m = n.match(/[a-z]([A-Z][a-z]+)$/);
        if (m) {
            const suf = m[1];
            suffixCounts[suf] = suffixCounts[suf] || [];
            suffixCounts[suf].push(n);
        }
    });
    Object.entries(suffixCounts).forEach(([suf, ns]) => {
        if (ns.length >= 3) evidence.push({ line: 0, snippet: `*${suf}: ${ns.join(', ')}` });
    });

    // One-liner sibling cluster: 3+ functions whose bodies are a single short statement.
    let oneLiners = 0;
    const oneLinerNames = [];
    named.forEach(({ name, line }) => {
        // Look at the next 1-2 non-empty lines for a short body.
        const bodyLines = [];
        for (let j = line; j < lines.length && bodyLines.length < 4; j++) {
            const t = lines[j];
            if (t.trim() === '') continue;
            bodyLines.push(t);
        }
        const bodyText = bodyLines.join('\n');
        const stmtCount = (bodyText.match(/return |[\w.]+\s*=/g) || []).length;
        const bodyLen = bodyText.replace(/\s+/g, ' ').length;
        if (stmtCount <= 2 && bodyLen < 80) {
            oneLiners++;
            oneLinerNames.push(name);
        }
    });
    if (oneLiners >= 3 && oneLinerNames.length >= 3) {
        evidence.push({ line: 0, snippet: `${oneLiners} one-liner siblings: ${oneLinerNames.slice(0, 5).join(', ')}` });
    }

    return {
        matched: evidence.length > 0,
        evidence,
        reason: "Several helpers share an LLM-favoured verb prefix, noun suffix, or are textbook one-liner siblings."
    };
}

function checkNoTodoFixme(code) {
    const lines = splitLines(code).filter(l => l.trim() !== '');
    if (lines.length < 25) return { matched: false, evidence: [], reason: "No TODO/FIXME/XXX/HACK in 25+ lines - production code almost always has at least one." };
    const matched = !/\b(TODO|FIXME|XXX|HACK)\b/.test(code);
    return {
        matched,
        evidence: matched ? [{ line: 0, snippet: `0 TODO/FIXME markers across ${lines.length} non-empty lines` }] : [],
        reason: "No TODO/FIXME/XXX/HACK in 25+ lines - production code almost always has at least one."
    };
}

// ---------- registry ----------

const HEURISTICS = [
    { id: "formatting_too_clean",         label: "Formatting too clean",          weight: 0.5,  maxWeight: 0.5,  run: checkFormattingTooClean },
    { id: "generic_names",                label: "Generic placeholder names",     weight: 1.5,  maxWeight: 1.5,  run: checkGenericNames },
    { id: "lack_of_comments",             label: "No comments at all",            weight: 1.0,  maxWeight: 1.0,  run: checkLackOfComments },
    { id: "repetitive_lines",             label: "Repetitive lines",              weight: 1.4,  maxWeight: 1.4,  run: checkRepetitiveLines },
    { id: "over_structured",              label: "Over-structured control flow",  weight: 1.0,  maxWeight: 1.0,  run: checkOverStructured },
    { id: "human_complexity",             label: "Human-style complexity",        weight: -1.0, maxWeight: 1.0,  run: checkHumanComplexity },
    { id: "over_commenting_trivial_ops",  label: "Over-commenting trivial ops",   weight: 2.0,  maxWeight: 2.0,  run: checkOverCommenting },
    { id: "preamble_strings",             label: "Conversational preamble",       weight: 1.6,  maxWeight: 1.6,  run: checkPreambleStrings },
    { id: "excessive_try_except",         label: "Excessive try/except",          weight: 1.6,  maxWeight: 1.6,  run: checkExcessiveTryExcept },
    { id: "jsdoc_on_everything",          label: "JSDoc on everything",           weight: 1.5,  maxWeight: 1.5,  run: checkJsdocOnEverything },
    { id: "defensive_null_checks",        label: "Defensive null checks",         weight: 1.3,  maxWeight: 1.3,  run: checkDefensiveNullChecks },
    { id: "symmetric_helper_names",       label: "Symmetric helper names",        weight: 1.1,  maxWeight: 1.1,  run: checkSymmetricHelperNames },
    { id: "no_todo_fixme",                label: "No TODO/FIXME markers",         weight: 0.4,  maxWeight: 0.4,  run: checkNoTodoFixme }
];

function runHeuristics(code) {
    return HEURISTICS.map(h => {
        const r = h.run(code);
        return {
            id: h.id,
            label: h.label,
            weight: h.weight,
            maxWeight: h.maxWeight,
            matched: r.matched,
            reason: r.reason,
            evidence: r.evidence || []
        };
    });
}

function aggregate(findings) {
    const sumMax = findings.reduce((a, f) => a + Math.abs(f.maxWeight), 0);
    const sumMatched = findings.reduce((a, f) => a + (f.matched ? f.weight : 0), 0);
    const percentage = clamp((sumMatched / sumMax) * 100, 0, 100);
    const verdict = percentage >= 50 ? { label: "Likely AI-generated", tone: "ai" }
                   : percentage >= 25 ? { label: "Mixed signals",       tone: "mixed" }
                                      : { label: "Likely human-written", tone: "human" };
    return { percentage, verdict, sumMatched, sumMax };
}

// ---------- rendering ----------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderResults(findings, agg) {
    const summary = document.getElementById('result-summary');
    const list = document.getElementById('result-findings');
    const toneClass = agg.verdict.tone === 'ai' ? 'verdict-ai'
                    : agg.verdict.tone === 'mixed' ? 'verdict-mixed'
                    : 'verdict-human';

    summary.innerHTML = `
        <div class="verdict-row">
            <span class="verdict-pill ${toneClass}">${escapeHtml(agg.verdict.label)}</span>
            <span class="verdict-percent">${agg.percentage.toFixed(1)}%</span>
        </div>
        <p class="verdict-sub">Score ${agg.sumMatched.toFixed(2)} of ${agg.sumMax.toFixed(2)} possible.</p>
    `;

    const matched = findings.filter(f => f.matched);
    const notMatched = findings.filter(f => !f.matched);

    const renderFinding = (f) => {
        const sign = f.weight < 0 ? '' : '+';
        const contribution = f.matched ? `${sign}${f.weight.toFixed(1)}` : '0';
        const pillTone = f.matched
            ? (f.weight < 0 ? 'pill-human' : 'pill-ai')
            : 'pill-neutral';
        const pillText = f.matched
            ? (f.weight < 0 ? 'human signal' : 'AI signal')
            : 'not matched';

        const evHtml = f.evidence.length
            ? `<ul class="evidence-list">${f.evidence.map(e => {
                const lineText = e.line ? `<span class="line-num">L${e.line}</span>` : '<span class="line-num">·</span>';
                return `<li class="evidence-line" data-line="${e.line || 0}">${lineText}<code>${escapeHtml(e.snippet)}</code></li>`;
            }).join('')}</ul>`
            : '';
        return `
            <details class="finding ${f.matched ? 'is-matched' : ''}" ${f.matched ? 'open' : ''}>
                <summary>
                    <span class="signal-pill ${pillTone}">${pillText}</span>
                    <span class="finding-label">${escapeHtml(f.label)}</span>
                    <span class="finding-weight">${contribution}</span>
                </summary>
                <p class="finding-reason">${escapeHtml(f.reason)}</p>
                ${evHtml}
            </details>
        `;
    };

    list.innerHTML = `
        <h3 class="findings-heading">Matched signals (${matched.length})</h3>
        ${matched.map(renderFinding).join('') || '<p class="findings-empty">None.</p>'}
        <h3 class="findings-heading">Not matched (${notMatched.length})</h3>
        ${notMatched.map(renderFinding).join('')}
    `;

    // Click an evidence line to jump the textarea selection there.
    list.querySelectorAll('.evidence-line').forEach(el => {
        el.addEventListener('click', () => {
            const line = parseInt(el.dataset.line, 10);
            if (line > 0) jumpTextareaToLine(line);
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

function analyzeCode() {
    const code = document.getElementById('inputCode').value;
    const result = document.getElementById('result');
    result.classList.remove('hidden');

    if (code.trim() === '') {
        document.getElementById('result-summary').innerHTML = '<p class="muted">Paste some code, then press Analyze.</p>';
        document.getElementById('result-findings').innerHTML = '';
        return;
    }

    const findings = runHeuristics(code);
    const agg = aggregate(findings);
    renderResults(findings, agg);
}

function resetForm() {
    document.getElementById('inputCode').value = '';
    document.getElementById('result').classList.add('hidden');
    document.getElementById('result-summary').innerHTML = '';
    document.getElementById('result-findings').innerHTML = '';
}

// ---------- gallery ----------

function renderGallery() {
    const grid = document.getElementById('gallery-grid');
    if (!grid) return;
    const examples = window.AI_CODE_EXAMPLES || [];

    grid.innerHTML = examples.map(ex => {
        const codeLines = ex.code.split('\n').map((l, i) => {
            const ln = i + 1;
            return `<span class="code-line" data-line="${ln}"><span class="code-line-num">${ln}</span><span class="code-line-text">${escapeHtml(l) || ' '}</span></span>`;
        }).join('');
        const annotations = ex.annotations.map((a, i) => {
            const range = a.lineRange[0] === a.lineRange[1] ? `L${a.lineRange[0]}` : `L${a.lineRange[0]}-L${a.lineRange[1]}`;
            return `<li class="annotation" data-from="${a.lineRange[0]}" data-to="${a.lineRange[1]}" data-card="${ex.id}">
                        <span class="annotation-range">${range}</span>
                        <span class="annotation-signal">${escapeHtml(a.signal)}</span>
                        <span class="annotation-why">${escapeHtml(a.why)}</span>
                    </li>`;
        }).join('');

        return `
            <article class="example-card" data-id="${ex.id}" data-language="${ex.language}">
                <header class="example-head">
                    <h3>${escapeHtml(ex.title)}</h3>
                    <div class="example-meta">
                        <span class="badge badge-${ex.language}">${escapeHtml(ex.language)}</span>
                        <span class="badge badge-source">${escapeHtml(ex.sourceLabel)}</span>
                        <span class="badge badge-${ex.provenance}">${escapeHtml(ex.provenance)}</span>
                    </div>
                </header>
                <p class="example-blurb">${escapeHtml(ex.blurb)}</p>
                <pre class="example-code"><code>${codeLines}</code></pre>
                <h4 class="annotations-heading">Why this looks AI-generated</h4>
                <ul class="annotations">${annotations}</ul>
                <button class="example-load" data-load="${ex.id}">Load into analyzer →</button>
            </article>
        `;
    }).join('');

    grid.querySelectorAll('.example-load').forEach(btn => {
        btn.addEventListener('click', () => loadExampleIntoAnalyzer(btn.dataset.load));
    });
    grid.querySelectorAll('.annotation').forEach(li => {
        li.addEventListener('mouseenter', () => highlightCardLines(li.dataset.card, +li.dataset.from, +li.dataset.to, true));
        li.addEventListener('mouseleave', () => highlightCardLines(li.dataset.card, +li.dataset.from, +li.dataset.to, false));
    });
}

function highlightCardLines(cardId, from, to, on) {
    const card = document.querySelector(`.example-card[data-id="${cardId}"]`);
    if (!card) return;
    card.querySelectorAll('.code-line').forEach(el => {
        const ln = parseInt(el.dataset.line, 10);
        el.classList.toggle('is-highlighted', on && ln >= from && ln <= to);
    });
}

function loadExampleIntoAnalyzer(id) {
    const ex = (window.AI_CODE_EXAMPLES || []).find(e => e.id === id);
    if (!ex) return;
    document.getElementById('inputCode').value = ex.code;
    switchTab('analyze');
    analyzeCode();
    document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- filter chips ----------

function setupFilters() {
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => c.classList.remove('is-active'));
            chip.classList.add('is-active');
            const f = chip.dataset.filter;
            document.querySelectorAll('.example-card').forEach(card => {
                card.classList.toggle('hidden', f !== 'all' && card.dataset.language !== f);
            });
        });
    });
}

// ---------- docs ----------

function renderDocs() {
    const list = document.getElementById('docs-list');
    if (!list) return;
    list.innerHTML = HEURISTICS.map(h => {
        const stub = h.run('').reason; // pull the canonical reason from a no-op call
        const sign = h.weight < 0 ? '' : '+';
        return `
            <article class="doc-row">
                <header>
                    <h3>${escapeHtml(h.label)}</h3>
                    <span class="finding-weight">${sign}${h.weight.toFixed(1)}</span>
                </header>
                <p class="muted">${escapeHtml(stub)}</p>
                <code class="doc-id">id: ${escapeHtml(h.id)}</code>
            </article>
        `;
    }).join('');
}

// ---------- tabs ----------

function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        const active = b.dataset.tab === name;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('hidden', p.dataset.panel !== name);
    });
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
}

// ---------- example dropdown ----------

function setupExampleDropdown() {
    const sel = document.getElementById('exampleLoader');
    if (!sel) return;
    const examples = window.AI_CODE_EXAMPLES || [];
    sel.innerHTML = '<option value="">Try an example…</option>' +
        examples.map(e => `<option value="${e.id}">${escapeHtml(e.title)} · ${escapeHtml(e.language)}</option>`).join('');
    sel.addEventListener('change', () => {
        if (sel.value) loadExampleIntoAnalyzer(sel.value);
        sel.value = '';
    });
}

// ---------- init ----------

function init() {
    document.getElementById('analyzeBtn').addEventListener('click', analyzeCode);
    document.getElementById('resetBtn').addEventListener('click', resetForm);
    setupTabs();
    setupExampleDropdown();
    setupFilters();
    renderGallery();
    renderDocs();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
