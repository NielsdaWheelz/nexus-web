# Dispatch-error HUD copy has no cross-subject proof

**Status:** open (the defect is fixed; the guard against its return is missing)
**Origin:** 2026-09-08, imports workspace hard cutover, Track E review fixes
**Area:** `apps/web/src/lib/actions/resourceActionRuntime.tsx`
(`dispatchErrorContent`, Track D ownership)

## What is wrong

`dispatchErrorContent` is the one owner mapping an expected dispatch error to
HUD copy for *every* resource action (`runResourceActionEffect`'s generic catch
and the destructive-settlement `NotCommitted` path). Track E added an
`E_RESOURCE_CONFLICT` branch that answers with the imports wording
"This import changed. Review its current status." That branch was installed
unconditionally at first, so a 409 on `DeleteConversation`, `DeleteLibrary`,
`RemoveMedia`, `Unsubscribe` or a lectern command would have told the reader an
import changed. It is now scoped to `intent.kind` in
`{RetrySource, RepairSource, RepairSearch}`.

Nothing proves the scoping. The only 409 case in the tree is the imports one
(`components/imports/ImportsWorkspace.browser.test.tsx`, "a stale recovery
shows the conflict notice…"); no proof asserts that a non-import subject's 409
still reads `Could not <label>`. Widening the branch again — or adding a fourth
intent to the tuple by accident — reddens nothing.

## Prerequisites

None. The layer has no canonical proof owner for dispatch-error copy: each pane
proof exercises its own subject's happy path, and `resourceActionRuntime.tsx`
belongs to Track D, so Track E did not add the case.

## Proposed fix

A named case in the runtime's own boundary proof (or, failing one, in
`components/resources/ResourceActionMenu.browser.test.tsx`) that dispatches a
non-import intent against a stubbed 409 and asserts the HUD reads
`Could not <label>` with the server message, beside the existing imports case
that asserts the conflict wording.

## Acceptance

Removing the `intent.kind` guard from `dispatchErrorContent` reddens a named
case that is not an imports case.
