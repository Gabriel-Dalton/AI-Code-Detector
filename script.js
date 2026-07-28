/* AI Code Detector
 *
 * Each heuristic is a function that returns a Finding:
 *   { matched, reason, evidence: [{ line, snippet }] }
 *
 * The registry attaches an id, a label, a weight and a plain-English
 * description. The aggregator normalises the score to 0..100 and the renderer
 * shows per-signal evidence (line numbers + snippets) so a reader can audit
 * WHY each signal fired rather than trusting the number.
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
    const re = new RegExp(`\\b(${generic.join('|')})\\b`, 'g');

    // One row per (identifier, line) pair. A `forEach` can't be broken out of,
    // so the scan runs as a plain loop with a hard cap.
    const evidence = [];
    const seen = new Set();
    const CAP = 24;
    outer:
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(l)) !== null) {
            const key = `${m[1]}:${i + 1}`;
            if (seen.has(key)) continue;
            seen.add(key);
            evidence.push({ line: i + 1, snippet: `${m[1]}  —  ${snippet(l.trim(), 64)}` });
            if (evidence.length >= CAP) break outer;
        }
    }
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
        .slice(0, 4)
        .map(([text, nums]) => ({ line: nums[0], snippet: `×${nums.length} on lines ${nums.join(', ')}  —  ${snippet(text, 52)}` }));
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
            if (evidence.length < 8) {
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
                if (evidence.length < 8) {
                    evidence.push({ line: ln, snippet: `${snippet(l.trim(), 46)}  →  ${snippet(next.trim(), 36)}` });
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
            if (evidence.length < 8) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
        }
        if (/}\s*catch\s*\(\s*\w*\s*\)\s*\{\s*$/.test(l) || /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(l)) {
            bareOrBroad++;
            if (evidence.length < 8) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
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
                if (evidence.length < 8) evidence.push({ line: i + 1, snippet: 'try: with a single-statement body' });
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
    // Count function declarations, arrow assignments, methods, constructors.
    const patterns = [
        /\bfunction\s+\w+\s*\(/g,
        /\b\w+\s*=\s*\([^)]*\)\s*=>/g,
        /\b\w+\s*:\s*function\b/g,
        /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:[\w<>?\[\],\s]+\s+)?\w+\s*\([^)]*\)\s*(?:\{|throws)/gm
    ];
    let funcCount = 0;
    patterns.forEach(re => { funcCount += (code.match(re) || []).length; });
    const jsdocBlocks = (code.match(/\/\*\*[\s\S]*?\*\//g) || []).length;
    const matched = funcCount >= 2 && jsdocBlocks >= Math.max(2, funcCount * 0.8);
    const lines = splitLines(code);
    const evidence = [];
    lines.forEach((l, i) => {
        if (/^\s*\/\*\*/.test(l) && evidence.length < 6) {
            evidence.push({ line: i + 1, snippet: 'JSDoc block opens here' });
        }
    });
    return {
        matched,
        evidence: matched ? [{ line: 0, snippet: `${jsdocBlocks} JSDoc blocks for ${funcCount} functions` }].concat(evidence) : [],
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
                if (evidence.length < 8) evidence.push({ line: i + 1, snippet: snippet(l.trim()) });
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
        if (ns.length >= 3) evidence.push({ line: 0, snippet: `${v}* prefix: ${ns.join(', ')}` });
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
        if (ns.length >= 3) evidence.push({ line: 0, snippet: `*${suf} suffix: ${ns.join(', ')}` });
    });

    // One-liner sibling cluster: 3+ functions whose bodies are a single short statement.
    let oneLiners = 0;
    const oneLinerNames = [];
    named.forEach(({ name, line }) => {
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
    const reason = "No TODO/FIXME/XXX/HACK in 25+ lines - production code almost always has at least one.";
    const lines = splitLines(code).filter(l => l.trim() !== '');
    if (lines.length < 25) return { matched: false, evidence: [], reason };
    const matched = !/\b(TODO|FIXME|XXX|HACK)\b/.test(code);
    return {
        matched,
        evidence: matched ? [{ line: 0, snippet: `0 TODO/FIXME markers across ${lines.length} non-empty lines` }] : [],
        reason
    };
}

// ---------- registry ----------

/* `about` is the canonical one-line description shown in the Heuristics tab.
   It is kept separate from a finding's runtime `reason`, which may interpolate
   counts from the snippet being analysed. */
const HEURISTICS = [
    {
        id: 'formatting_too_clean', label: 'Formatting too clean', weight: 0.5, maxWeight: 0.5,
        about: 'Indentation lands in clean 2/4-space (or tab) steps with no mixed indents and no trailing whitespace.',
        run: checkFormattingTooClean
    },
    {
        id: 'generic_names', label: 'Generic placeholder names', weight: 1.5, maxWeight: 1.5,
        about: 'Reaches for data, result, value, temp, payload and friends instead of domain vocabulary.',
        run: checkGenericNames
    },
    {
        id: 'lack_of_comments', label: 'No comments at all', weight: 1.0, maxWeight: 1.0,
        about: 'Zero comments across 25+ non-empty lines. String-aware, so arithmetic no longer false-positives.',
        run: checkLackOfComments
    },
    {
        id: 'repetitive_lines', label: 'Repetitive lines', weight: 1.4, maxWeight: 1.4,
        about: 'More than ~20% of lines duplicated verbatim, across at least two distinct duplicate clusters.',
        run: checkRepetitiveLines
    },
    {
        id: 'over_structured', label: 'Over-structured control flow', weight: 1.0, maxWeight: 1.0,
        about: 'More than five if/for/while/switch blocks packed into one snippet.',
        run: checkOverStructured
    },
    {
        id: 'human_complexity', label: 'Human-style complexity', weight: -1.0, maxWeight: 1.0,
        about: 'A wide spread of language features in play — counted as a human signal, so it pulls the score down.',
        run: checkHumanComplexity
    },
    {
        id: 'over_commenting_trivial_ops', label: 'Over-commenting trivial ops', weight: 2.0, maxWeight: 2.0,
        about: 'Comment density above 50%, or four or more comments shadowing a single short statement.',
        run: checkOverCommenting
    },
    {
        id: 'preamble_strings', label: 'Conversational preamble', weight: 1.6, maxWeight: 1.6,
        about: '"Here\'s…", "Below is…", "Sure!", "Let me…" surviving in the first six lines.',
        run: checkPreambleStrings
    },
    {
        id: 'excessive_try_except', label: 'Excessive try/except', weight: 1.6, maxWeight: 1.6,
        about: 'Repeated broad except Exception (Python) or empty catch (JS), or try bodies wrapping one statement.',
        run: checkExcessiveTryExcept
    },
    {
        id: 'jsdoc_on_everything', label: 'JSDoc on everything', weight: 1.5, maxWeight: 1.5,
        about: 'At least 80% of functions carry a JSDoc block, one-liners included.',
        run: checkJsdocOnEverything
    },
    {
        id: 'defensive_null_checks', label: 'Defensive null checks', weight: 1.3, maxWeight: 1.3,
        about: 'A pile of if x is None / if (!x) / === null guards against inputs that cannot occur.',
        run: checkDefensiveNullChecks
    },
    {
        id: 'symmetric_helper_names', label: 'Symmetric helper names', weight: 1.1, maxWeight: 1.1,
        about: 'Three or more helpers sharing an LLM-favourite verb prefix (process*, handle*, format*, …).',
        run: checkSymmetricHelperNames
    },
    {
        id: 'no_todo_fixme', label: 'No TODO/FIXME markers', weight: 0.4, maxWeight: 0.4,
        about: 'Not a single TODO/FIXME/XXX/HACK marker in 25+ lines of code.',
        run: checkNoTodoFixme
    }
];

// Collapse identical rows and rows that repeat a line/snippet pair, so a
// finding presents a readable list rather than a dump.
function dedupeEvidence(evidence) {
    const seen = new Set();
    const out = [];
    for (const e of evidence) {
        const key = `${e.line} ${e.snippet}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out;
}

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
            evidence: dedupeEvidence(r.evidence || [])
        };
    });
}

const DEFAULT_THRESHOLDS = { mixed: 25, ai: 50 };

function readThresholds() {
    const m = parseInt(document.getElementById('thresholdMixed')?.value, 10);
    const a = parseInt(document.getElementById('thresholdAi')?.value, 10);
    const mixed = Number.isFinite(m) ? clamp(m, 0, 100) : DEFAULT_THRESHOLDS.mixed;
    const ai = Number.isFinite(a) ? clamp(a, 0, 100) : DEFAULT_THRESHOLDS.ai;
    return { mixed: Math.min(mixed, ai - 1), ai: Math.max(ai, mixed + 1) };
}

function aggregate(findings, thresholds = readThresholds()) {
    const sumMax = findings.reduce((a, f) => a + Math.abs(f.maxWeight), 0);
    const sumMatched = findings.reduce((a, f) => a + (f.matched ? f.weight : 0), 0);
    const percentage = clamp((sumMatched / sumMax) * 100, 0, 100);
    const verdict = percentage >= thresholds.ai
                        ? { label: 'Likely AI-generated', tone: 'ai' }
                    : percentage >= thresholds.mixed
                        ? { label: 'Mixed signals', tone: 'mixed' }
                        : { label: 'Likely human-written', tone: 'human' };
    return { percentage, verdict, sumMatched, sumMax, thresholds };
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
    renderResults(...(() => {
        const findings = runHeuristics(code);
        return [findings, aggregate(findings)];
    })());
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
            return `<li class="annotation" data-from="${from}" data-to="${to}" data-card="${ex.id}">
                        <span class="annotation-range">${range}</span>
                        <span class="annotation-signal">${escapeHtml(a.signal)}</span>
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
