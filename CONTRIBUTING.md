# Contributing

Contributions are welcome, and the most useful ones are usually small: a
heuristic that misfires, a sample that demonstrates a tell the gallery is
missing, a false positive on code you actually wrote.

## Getting set up

There is no build step. Clone it and open `index.html`:

```bash
git clone https://github.com/Gabriel-Dalton/AI-Code-Detector.git
cd AI-Code-Detector
open index.html          # or: npm run serve && open http://localhost:8899
```

The dev tooling — the test runner's browser, the static server — needs one
install, but the app never does:

```bash
npm install
npm test                 # the whole suite, no browser needed
```

`npm test` runs on Node's built-in test runner and requires no dependencies at
all, so it works on a fresh clone before `npm install` finishes.

## How the code is arranged

| File | What lives there |
| --- | --- |
| `detector.js` | The engine. Pure functions: string in, findings out. No DOM. |
| `script.js` | The UI. Everything touching the DOM, `localStorage` or the user. |
| `examples.js` | The annotated sample gallery, as data. |
| `style.css` | Design tokens, then components. |
| `index.html` | The whole entry point. The three script tags are the build system. |
| `test/` | Node tests over `detector.js` and `examples.js`. |
| `scripts/` | Dev tooling: the contrast audit and the screenshot generator. |

The split between `detector.js` and `script.js` is the one structural rule worth
protecting. The engine is testable precisely because it has no idea a browser
exists — if a change to a heuristic needs `document`, that's a sign the logic
wants to move up into the UI layer instead.

## Adding or changing a heuristic

One entry in the `HEURISTICS` array in `detector.js`:

```js
{
    id: 'my_signal',              // stable; annotations and tests refer to it
    label: 'My signal',           // shown in the findings list
    weight: 1.2,                  // positive = AI tell, negative = human signal
    maxWeight: 1.2,               // |weight| — the scoring denominator uses this
    about: 'One line for the Heuristics tab.',
    run: checkMySignal            // (code) => { matched, reason, evidence }
}
```

`run` returns:

- `matched` — a boolean;
- `reason` — a sentence a reader can act on, which may interpolate counts;
- `evidence` — `[{ line, snippet }]`. Use `line: 0` when the finding is about
  the snippet as a whole (a density, a count) and has no single line to cite.

The Heuristics tab, the signal counts in the masthead and the scoring
denominator all derive from that array, so nothing else needs touching.

**Every heuristic needs a fixture pair.** `test/heuristics.test.mjs` keeps a
`fires` and a `quiet` snippet per signal, and the suite fails if a registered
signal has no fixture. The `quiet` half is the one that matters: a detector that
fires on everything has perfect recall and no value, so pick a snippet that sits
just the other side of the threshold — the same shape of code without the tell.

Adding a signal also means the score of every existing snippet shifts, because
the denominator grows. That is expected; what isn't expected is the gallery
changing verdicts, and the tests will tell you if it did.

## Adding a gallery sample

One entry in `examples.js`. Two fields carry obligations:

- **`expectedSignals`** is a live assertion, not documentation. The suite checks
  the detector really flags each one on that sample.
- **`annotations`** each name a `signal`. If you're describing a tell this
  detector doesn't score — because it's below a length gate, or matches literal
  text where your sample only repeats a shape — set `scored: false` and say why
  in the `why` text. The card renders a `not scored` marker so a reader isn't
  told the analyzer caught something it didn't.

Prefer **curated** samples distilled from common idioms: they keep each card
focused on one teaching point, and they sidestep the licensing question that
comes with pasting a real transcript. Mark anything that *is* a real capture as
`verbatim` with the model that produced it.

## Changing the UI

Two rules keep the design coherent:

- **Monospace is for code and figures only.** Labels, badges and headings belong
  to the sans, or the serif for titles. Wide-tracked uppercase mono on every
  label is itself a visual cliché of generated design — see *Design notes* in
  the README for why this one is load-bearing.
- **Colours go through the tokens** at the top of `style.css`, declared once
  with `light-dark()`. A raw hex value in a component rule will be wrong in one
  of the two themes.

Then run the contrast audit, because a new colour pairing is exactly what it
exists to catch:

```bash
npm run serve &
npm run audit:contrast
```

It renders the real page in both themes across six interaction states and
checks every foreground/background pair against WCAG 2.1 AA, reading computed
styles rather than the token table. It exits non-zero on any failure.

If your change is visible, regenerate the README figures in the same commit:

```bash
npm run screenshots
```

## Before opening a pull request

```bash
npm test                 # 190+ assertions, no browser
npm run serve &
npm run audit:contrast   # WCAG AA in both themes
```

CI runs both on every push. Keep the diff to one concern, and say in the
description what you'd expect to break if you got it wrong.

## Reporting things

- **A false positive or false negative** is the most useful bug report this
  project can get. Include the snippet, which signal fired or didn't, and what
  you'd have expected.
- **Security** — see [SECURITY.md](SECURITY.md).
- **Conduct** — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
