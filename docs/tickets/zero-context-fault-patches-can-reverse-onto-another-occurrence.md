# Fault patches with no leading context can reverse onto another occurrence

**Status:** open
**Origin:** Imports workspace cutover, Phase 9, 2026-09-10
**Area:** `testdata/faults/*.patch`, `nexus_test_control/sensitivity.py`

## What is wrong

`applied_fault` applies a registered fault with `git apply`, runs the proof, then
reverses it with `git apply --reverse` and requires the checkout to be restored.
`git apply` matches a hunk by its context, so a hunk whose only context is one
line can bind to a different occurrence of that line than the one it was cut
from — forward and reverse then touch different places and the reversal check
fails, or worse, succeeds against the wrong site.

`reader-restore-write-suppression-bypass.patch` did exactly that once the cutover
shifted `MediaPaneBody.tsx`: `@@ -3101,2 +3101,1 @@` with the single context line
`scrollRestoreAppliedRef.current = true;` (which occurs five times in that file)
forward-applied at line 2561 and reversed at line 3050, so `prove` failed with
"fault reversal did not restore the isolated checkout". Phase 9 regenerated that
patch with three lines of leading context and repinned its `sha256`.

Five registered patches still carry a single context line and no leading context,
so they are one refactor away from the same failure:

- `conversation-fork-delete-confirmation-bypass.patch`
- `durable-codex-state-encryption-admission-bypass.patch`
- `epub-offset-interval-validation-bypass.patch`
- `epub-structural-anchor-preservation-bypass.patch`
- `llm-tool-projection-gate-bypass.patch`

## Evidence

- Old patch replayed in a scratch checkout of `e7c6d9fe`: forward applies at
  2561, reverse applies at 3050, `git diff --exit-code` dirty.
- New patch (three context lines) in the same checkout: forward, reverse, and
  `git diff --exit-code` clean.
- `python/nexus_test_control/sensitivity.py:757-772` (`_apply_fault`,
  `applied_fault`).

## Prerequisites

None.

## Proposed fix

Regenerate the five patches with `git diff -U3` (the default), repin each
`sha256` in `testdata/faults/manifest.json`, and add a registry kernel case that
rejects a registered patch whose hunks carry fewer than three lines of leading
context, so a hand-trimmed fault cannot enter the manifest again.

## Acceptance

A kernel case fails on a manifest entry whose patch has a hunk with fewer than
three leading context lines; `prove --against fault:<id>` round-trips for each of
the five ids on a tree where their owner files have moved.
