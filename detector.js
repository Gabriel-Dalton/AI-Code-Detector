/* AI Code Detector — the detection engine.
 *
 * Pure functions only: string in, findings out. No DOM, no storage, no
 * network. `script.js` is the UI layer on top of this file, and everything
 * here is exercised directly by `test/` under Node.
 *
 * Each heuristic is a function that returns a Finding:
 *   { matched, reason, evidence: [{ line, snippet }] }
 *
 * The registry attaches an id, a label, a weight and a plain-English
 * description. The aggregator normalises the score to 0..100 and the renderer
 * shows per-signal evidence (line numbers + snippets) so a reader can audit
 * WHY each signal fired rather than trusting the number.
 *
 * Loaded as a plain script tag in the browser — no build step, no module
 * syntax. The footer re-exports for Node so the tests can require() it.
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

/* Returns the set of line numbers (1-indexed) whose content is a comment.
   Runs on the string-stripped copy, so a `//` inside a URL literal doesn't
   count. "Is a comment" means the whole line is one: `code(); /* note *​/` is a
   code line that happens to carry a note, and counting it would inflate the
   comment density that two heuristics read.

   Block comments are tracked by scanning for the delimiters anywhere on the
   line rather than only at its start, because a block can open mid-line
   (`const x = 1; /* why ...`). Doing it properly is what allows the old
   "a line starting with * is a comment" shortcut to be dropped — that rule
   guessed right for JSDoc body lines but also swallowed operator
   continuations, so

       const area = width
           * height;

   counted line 2 as a comment and quietly skewed both comment-density
   signals. JSDoc bodies are still caught, now via the block state that
   actually opened them. */
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

        // Walk every delimiter pair on the line, so a second, unterminated
        // open (`a /* one *​/ + b /* two`) still leaves us inside a block.
        let cursor = 0;
        let sawOpen = false;
        for (;;) {
            const open = line.indexOf('/*', cursor);
            if (open === -1) break;
            sawOpen = true;
            const close = line.indexOf('*/', open + 2);
            if (close === -1) { inBlock = true; break; }
            cursor = close + 2;
        }
        if (sawOpen) {
            if (trimmed.startsWith('/*')) set.add(ln);
            return;
        }

        if (trimmed.startsWith('//') || trimmed.startsWith('#')) set.add(ln);
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
        // \u0000 as the separator: it cannot occur in a line number or in a
        // snippet, so "1:2" and "1" + ":2" can never collide. Written as an
        // escape rather than a literal NUL so this file stays plain text --
        // a raw NUL byte makes grep, file(1) and most editors treat it as binary.
        const key = `${e.line}\u0000${e.snippet}`;
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

// ---------- scoring ----------

const DEFAULT_THRESHOLDS = { mixed: 25, ai: 50 };

/* Coerce a pair of user-supplied thresholds into a usable band.
   Both stay inside 0..100 and `mixed` stays strictly below `ai`, so the three
   verdict bands can never invert or collapse into each other.

   The ordering fix has to come *after* the clamp and be re-clamped itself.
   Clamping first and then nudging (the obvious way round) lets the nudge push a
   value straight back out of range: mixed=100 with ai=0 used to normalise to
   { mixed: -1, ai: 101 }, and since no score can reach 101, every snippet came
   back "Mixed signals" no matter what it contained.

   When the two are crossed, `ai` wins and `mixed` slides underneath it. Which
   one the user actually just edited is not knowable from here, so the threshold
   that decides the headline verdict is the one kept intact. */
function normaliseThresholds({ mixed, ai } = {}) {
    // 0..99 and 1..100 respectively: the band needs at least one point of gap,
    // so neither end can sit on the value that would leave no room for it.
    let m = Number.isFinite(mixed) ? clamp(mixed, 0, 99) : DEFAULT_THRESHOLDS.mixed;
    const a = Number.isFinite(ai) ? clamp(ai, 1, 100) : DEFAULT_THRESHOLDS.ai;
    if (m >= a) m = a - 1;
    return { mixed: m, ai: a };
}

function aggregate(findings, thresholds = DEFAULT_THRESHOLDS) {
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

/* ---------------------------------------------------------------------------
   Node interop. In the browser this whole block is skipped and every symbol
   above stays a plain global, exactly as before — which is what keeps
   index.html working with no build step and no module loader. Under Node
   (`test/`) the same file is a CommonJS module, so the engine can be tested
   without a DOM, a bundler or a headless browser.
   --------------------------------------------------------------------------- */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // scoring
        HEURISTICS,
        runHeuristics,
        aggregate,
        normaliseThresholds,
        DEFAULT_THRESHOLDS,
        // internals, exported so they can be tested directly rather than
        // only through whatever a fixture happens to exercise
        splitLines,
        clamp,
        stripStrings,
        commentLineSet,
        snippet,
        dedupeEvidence
    };
}
