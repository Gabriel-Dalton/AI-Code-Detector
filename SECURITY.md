# Security Policy

## Threat model, briefly

This is a static page: HTML, CSS and three JavaScript files, served as files.
There is no backend, no build step, no runtime dependency, no network call and
no telemetry. Nothing you paste into it leaves your browser, and the only thing
it persists is your last snippet, your two threshold values and your theme
choice, in `localStorage` under the `ai-code-detector:` prefix.

That rules out most of what a security policy usually covers. What's left is
worth reporting:

- **Cross-site scripting.** The app renders your input back to you — as line
  numbers, snippets and evidence rows. It escapes on the way out, but a bypass
  is a real finding.
- **Prototype pollution or similar** via a crafted snippet reaching the
  heuristics.
- **A dependency issue** in the dev tooling (`playwright`, `http-server`) that
  affects contributors running the audit or the tests.
- **Anything that makes a network request.** The masthead claims the page makes
  none, the fonts are vendored locally to keep that true, and a change that
  quietly breaks the claim is a privacy bug worth reporting as one.

## Reporting

Please report privately, not in a public issue:

**[Open a private security advisory](https://github.com/Gabriel-Dalton/AI-Code-Detector/security/advisories/new)**
via GitHub's "Report a vulnerability" flow. It's visible only to the maintainers
until a fix is published.

Useful to include:

- what happens, and the smallest input that causes it;
- which browser and version;
- what you think an attacker gets out of it.

You should get an acknowledgement within a week. Since there is no server to
patch and no released package to revoke, a fix ships as a commit to `main` and
the deployed page picks it up on the next load — so the turnaround is usually
short.

## Supported versions

The deployed page and `main` are the same thing, and only the latest version is
supported. Tagged releases are snapshots for reference; fixes land on `main`.

| Version | Supported |
| --- | --- |
| `main` / latest release | Yes |
| Earlier tags | No |

## Scope

Out of scope, because they aren't defects:

- **The verdict being wrong.** The detector is a panel of heuristics with
  published weights, not a classifier with a guarantee. A false positive is a
  useful bug report ([open an issue](https://github.com/Gabriel-Dalton/AI-Code-Detector/issues))
  but not a security one.
- **Evading detection.** Anyone can read the thirteen heuristics in
  `detector.js` and write code that dodges them. That's inherent to publishing
  the heuristics, which is the point of the project.
