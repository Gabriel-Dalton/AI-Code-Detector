# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Since the app ships as a static page rather than a package, a "release" is a
tagged snapshot of `main`; the deployed page always tracks `main`.

## [1.0.0] — 2026-07-28

First tagged release. The app itself has been usable for a while; this is the
release that makes the repository hold itself to the standard it asks of
contributors — a test suite, CI, a licence file, and figures that regenerate
from a command instead of being taken by hand.

### Added

- **A test suite, on Node's built-in runner with no dependencies.** 190+
  assertions covering all thirteen heuristics (each with a fixture it must fire
  on *and* one it must stay quiet on), the scoring arithmetic, the verdict
  bands, threshold normalisation, the shared string helpers, and degenerate
  input. `npm test` works on a fresh clone before `npm install` finishes.
- **`detector.js`** — the detection engine, split out of `script.js`. Pure
  functions, no DOM, no storage, no network. This is what made the engine
  testable; `script.js` is now purely the UI layer on top of it. In the browser
  both stay plain scripts, so there is still no build step.
- **The gallery's `expectedSignals` self-test now runs.** `examples.js` has
  always described that field as a self-test, but nothing checked it. Every
  sample's declared signals are now asserted against the live detector, so a
  heuristic can't be tightened until it stops firing on the very sample the
  gallery uses to teach it.
- **`scored: false` on annotations.** An annotation can describe a tell the
  detector doesn't score — one below a length gate, or matching literal text
  where the sample only repeats a shape. Those now say so, render a `not scored`
  marker on the card, and are exempted from the assertion above. Three existing
  annotations were making claims the analyzer wouldn't reproduce.
- **`scripts/screenshots.mjs`** — regenerates every README figure at a fixed
  viewport with fonts loaded, transitions frozen and `localStorage` cleared, so
  the docs can be updated in the same commit as a UI change instead of drifting.
- **CI on GitHub Actions** — the test suite across Node 20/22/24, plus the WCAG
  contrast audit in both themes, on every push and pull request.
- **`scripts/browser.mjs`** — shared Chromium resolution for both Playwright
  scripts. Playwright pins an exact browser revision and refuses anything else;
  these scripts only read colours and take pictures, so any recent Chromium
  will do. Sandboxes and CI images that already ship one no longer hit a wall of
  text telling them to re-download it.
- Repository documentation: `LICENSE` (the README claimed MIT with no file to
  back it), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, this
  changelog, `.editorconfig`, issue and pull request templates, and Dependabot.

### Fixed

- **Threshold normalisation could put the verdict bands out of reach.** The
  clamp to 0–100 ran *before* the fix that keeps `mixed` below `ai`, so the fix
  could push a value straight back outside the range: setting *Mixed ≥* to 100
  and *AI ≥* to 0 normalised to `{ mixed: -1, ai: 101 }`, and since no score can
  reach 101, every snippet came back "Mixed signals" regardless of content. Both
  ends now stay in range.
- **A line beginning with `*` was counted as a comment**, so an operator
  continuation —

  ```js
  const area = width
      * height;
  ```

  — read as a comment line and skewed both comment-density signals. Block
  comments are now tracked by scanning for delimiters anywhere on the line,
  including mid-line opens (`const x = 1; /* why ...`), which is what allowed
  the `*` shortcut to be dropped. JSDoc bodies are still counted, now via the
  block state that actually opened them.
- **A raw NUL byte in the evidence de-duplication key** made `script.js`
  register as a binary file to `grep`, `file(1)` and most editors. It is now
  written as a `\u0000` escape — same value, plain-text file.
- Three gallery annotations cited signals the detector doesn't fire on those
  samples, including one whose text claimed "30+ lines of code" for a sample
  with 21 non-empty lines, below the signal's 25-line gate.

### Changed

- `aggregate()` no longer reads the DOM through a default argument. It takes
  thresholds explicitly and defaults to the constant; the UI passes in what the
  number inputs hold. This is what let the scoring move into `detector.js`.
- `package.json` gained `test` and `screenshots` scripts, repository metadata,
  and an `engines` floor of Node 20 (for the stable built-in test runner).
- `package-lock.json` is now committed, so CI can use `npm ci` and Dependabot
  can see the resolved tree.
- README rebuilt around the new layout, with regenerated figures, and a
  **Known limitations** section — see below.

### Known limitations

Documented rather than fixed, because changing them changes every verdict the
tool produces and that should be a deliberate decision:

- **The heuristics are calibrated for snippets, not whole files.** Several are
  gated on absolute counts (`over_structured` fires above five control-flow
  blocks; `no_todo_fixme` and `lack_of_comments` need 25+ non-empty lines), and
  any real file clears those gates for reasons that have nothing to do with who
  wrote it. Pasting this repository's own hand-written `script.js` scores 40.3%,
  higher than six of the eight known-generated samples in its own gallery.
  Length-normalised thresholds are on the roadmap.
- **Nothing in the gallery reaches "Likely AI-generated" at the default 50%
  threshold.** The eight samples span 19.5% to 40.9%. They are all genuinely
  generated code, so either the default threshold is high or the weights are
  conservative. The tests pin the weaker property that holds today — every
  sample outscores a hand-written reference snippet — rather than asserting a
  calibration that doesn't.

[1.0.0]: https://github.com/Gabriel-Dalton/AI-Code-Detector/releases/tag/v1.0.0
