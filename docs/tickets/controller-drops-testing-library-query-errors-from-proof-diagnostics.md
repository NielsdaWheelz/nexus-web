# A browser proof's testing-library failure loses its diagnostic in the controller

**Status:** open
**Origin:** Imports workspace cutover, Track F chain F-fix3, 2026-09-09, while
re-deriving the fault fingerprints the honest way
**Area:** `python/nexus_test_control/runner.py` (`_decisive_output`,
`_classified_exact_result`); `testdata/faults/manifest.json`

## What is wrong

`_decisive_output` (`runner.py:5987-6008`) bounds a failing command's captured
output at 1900 characters and, past that bound, keeps only lines matching its
decisive regex: `E assert` / `E AssertionError` / `E Failed:` / `FAILED ` /
`AssertionError:` / `Error: expect(` / `expect(received|locator).toX(` /
`Tests N failed` / `falsifying example:`.

A Testing Library query error carries none of those markers. Its message is
`TestingLibraryElementError: Unable to find …`, so for any browser proof whose
red is a missing element — the most common browser red there is — the retained
detail collapses to the reporter's own summary:

    stdout= Test Files  1 failed (1)
          Tests  1 failed | 16 passed (27) | stderr=⎯⎯⎯ Failed Tests 1 ⎯⎯⎯

Two consequences:

1. `behavioral_red` (`sensitivity.py:296-322`) compares `expected_failure`
   against that detail, so a fault whose proof's first red is a query error
   **cannot** carry a fault-specific fingerprint — the only substrings the
   harness can see are counts. `document-import-upload-retry-ui-bypass` hit
   exactly this: its registered accessible-name fingerprint could never have
   matched. It is fingerprinted again now only because the case that fails first
   under it was given an `expect(...).not.toBeNull()` guard ahead of the label
   lookup, so the red arrives as an `AssertionError:` line the regex keeps. That
   works, but it makes every future browser fault depend on the proof author
   remembering to put a marked assertion in front of the query.
2. Whoever reads a failed run's evidence sees no reason for the failure, only a
   count.

The classifier already knows about the truncation — `_classified_exact_result`
has a branch accepting a bare `Tests N failed` summary as a behavioral failure
"rather than reject a real red on truncation" — so this ticket is about the
diagnostic that branch works around.

## Prerequisites

None. It is a one-line addition to a regex plus a proof in the controller's own
kernel suite (`python/tests/kernel/nexus_test_control/test_runner.py` owns
`_decisive_output`'s behaviour today).

## Proposed fix

Add the Testing Library and generic browser error forms to the decisive-line
regex (`TestingLibraryElementError:`, `Unable to find `, and the `Error: ` +
`toBeVisible/toHaveFocus/toHaveAttribute` matcher forms already partially
covered), with a kernel case that feeds a captured vitest failure over the
1900-character bound and asserts the message survives.

## Acceptance

A vitest failure whose only diagnostic is a Testing Library query error keeps
that sentence in `CapabilityResult.detail` past the 1900-character bound, so a
browser fault can be fingerprinted from the query error itself rather than from
a guard assertion placed ahead of the query.
