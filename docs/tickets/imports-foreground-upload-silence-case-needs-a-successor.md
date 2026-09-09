# The foreground-upload silence case lost its proof owner

**Status:** open (Track E to relocate, per contract §6)
**Origin:** Imports workspace cutover, Track D2, 2026-09-08
**Area:** `apps/web/src/components/nexus/AddPanel.browser.test.tsx`

## What is wrong

`lib/media/MediaActivityProvider.browser.test.tsx` is deleted by this cut. Its case
`keeps foreground upload work out of Activity until publication` proved a real risk:
`uploadIngestFile` must not publish an invalidation (and so must not put a row in the
workspace) until the confirm succeeds. Every other case in that file has a named
successor in `lib/imports/ImportsProvider.browser.test.tsx`; this one does not,
because the risk belongs to the Add lane, not to the provider.

Contract §6 already assigns the relocation: Track E moves "the foreground
`AddPanel`/`uploadIngestFile` cases into `components/nexus/AddPanel.browser.test.tsx`".

## Proposed fix

Add a named case to `AddPanel.browser.test.tsx` that runs `uploadIngestFile` against
a stubbed BFF whose PUT is deferred, and asserts no `Imports.Invalidated` signal is
published before the confirm resolves, and exactly one after it.

## Acceptance

`docs/local-rules/testing-standards.md` §13's rule holds: the deleted file's every
named risk is carried by a named case in an owner proof.
