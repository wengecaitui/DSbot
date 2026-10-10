# Repository-maintained sprintf-js security fork

This directory contains `sprintf-js` 1.1.3 under its original BSD-3-Clause
license, with a local fix for [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
The advisory has no published upstream patched version as of 2026-10-10.
`@dsbot/sprintf-js@1.1.3-dsbot.1` is a private, repository-maintained fork;
it is not an upstream release or an audit exception.

Source: https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz

Unmodified `src/sprintf.js` SHA-256:
`95add43f116385be221745307fae02d06751b01d4f939df1debb17dbe2ebf4eb`.

## Change and compatibility

Numeric precision is saturated to ECMAScript's supported range before invoking
`toFixed` / `toExponential` (0–100) or `toPrecision` (1–100).
This includes excessively long digit strings that convert to Infinity.
The library does not throw a replacement exception for an out-of-range precision:
that would leave asynchronous loggers vulnerable to the same process crash.
Valid precision, positional and named arguments, string truncation, and `vsprintf`
retain their formatting behavior. `%g` accepts numeric strings as the older 1.0
consumer version did. Other invalid formats and unrelated resource limits are
outside this advisory's fix.

The root `sprintf-js` file dependency and `$sprintf-js` override route all
argparse and Roarr consumers to this directory. No install scripts or downloaded
patches are required. `tests/security/dependency-security-regressions.test.ts`
checks both the crash payloads and every installed consumer's resolution, plus
actual Roarr logging, argparse, and Mammoth document parsing.
`npm run security:audit` runs these security regressions before invoking the
registry audit, including in both CI security jobs. The regressions also run in
the full test suite.

The npm advisory database does not assess this private fork's source. A clean
audit must therefore be accompanied by these behavior/resolution tests; changing
the package name alone would not constitute a security fix. Replace this fork
with a reviewed upstream fix when one becomes available, keeping the regression
tests and removing the file dependency and override together.
