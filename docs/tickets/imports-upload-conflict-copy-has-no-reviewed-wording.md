# The `Conflicted` upload outcome reaches readers with unreviewed copy

**Status:** open (Track E to own; content-designer review pending, contract D15)
**Origin:** Imports workspace cutover, Track D2, 2026-09-08
**Area:** `apps/web/src/lib/actions/resourceActionRuntime.tsx`;
`apps/web/src/lib/status/mediaActivity.ts`;
`apps/web/src/components/nexus/addContentSessionModel.ts`;
`apps/web/src/lib/media/captureFeedback.ts`

## What is wrong

`uploadSessionOutcome("Retry", …)` now maps `409 E_RESOURCE_CONFLICT` to a modeled
`{ kind: "Conflicted" }` outcome (the stale `expected_generation` fence of contract
§3). Widening `UploadSessionOutcome` makes every exhaustive copy switch a type
error until it names the new variant, so Track D2 added the three branches needed
to compile:

- `uploadSessionActionErrorMessage` → `This import changed. Review its current status.`
  (the notice contract §6 already reserves for a stale recovery)
- `acceptanceErrorMessage` → grouped with `Unresolved`
- `uploadSessionAttachmentMessage` (capture) → grouped with `Unresolved`

The Add-sheet and capture groupings are structurally safe — only the retry endpoint
can produce `Conflicted`, and neither lane calls it — but none of the three strings
has been through the content rubric, and two of them still say "Import Activity".

## Prerequisites

Track E's `lib/status/imports.ts` (which replaces `lib/status/mediaActivity.ts`).

## Proposed fix

When Track E consolidates the copy owners, give `Conflicted` its own reviewed line
in `lib/status/imports.ts`, decide whether the Add sheet should model it at all
(it cannot occur there), and delete the placeholder groupings.

## Acceptance

Every `UploadSessionOutcome` branch that a reader can reach has reviewed copy, and
no Imports copy says "Import Activity".

## The media half of the same gap

A stale `RetrySource` / `RepairSource` / `RepairSearch` command answers
`409 E_RESOURCE_CONFLICT` as an ordinary `ApiError`, so
`resourceActionRuntime.dispatchErrorContent` renders the generic
`Could not retry source processing` plus the server's message. Contract §5 asks
for the conflict copy instead, and contract §6 already reserves the wording:
`This import changed. Review its current status.`

Track D2 did not add that branch: `dispatchErrorContent` is "the one exhaustive
owner mapping an expected dispatch error to HUD copy", and adding reviewed product
copy there without a case that renders it would ship unproven wording. The variant
is exposed for the copy owner: the error is an `ApiError` whose `code` is
`E_RESOURCE_CONFLICT`, and its `details` carry the server's `current` identity.

## Proposed fix (media half)

Track E adds the `E_RESOURCE_CONFLICT` branch to `dispatchErrorContent` and proves
it in `components/imports/ImportsWorkspace.browser.test.tsx`, whose named case
"a stale (409) recovery shows the conflict notice and keeps the last-good row"
(contract §6) is exactly this risk.
