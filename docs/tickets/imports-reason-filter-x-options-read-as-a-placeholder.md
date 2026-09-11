# The Reason filter's X options read as an unsubstituted placeholder

**Status:** open
**Origin:** 2026-09-09, imports workspace hard cutover, D15 desktop visual/assistive
review (chain W1)
**Area:** `apps/web/src/lib/status/imports.ts` (`IMPORT_FAILURE_COPY[...].reason`),
`apps/web/src/components/imports/ImportsWorkspace.tsx` (the Reason `SelectField`)

## What is wrong

Five of the 46 alphabetised options in the Reason filter begin with a bare `X`:

```
X allowance used up · X did not respond in time · X is limiting imports
X is unavailable   · X rejected the request
```

They are the correct external spelling of the platform (`E_X_PROVIDER_*`), and
they read correctly on a row or in the inspector, where the source is already on
screen. In a flat alphabetised menu, with no X import in front of the reader,
the leading token reads as a template variable that was never substituted.

## Evidence

- `<scratchpad>/evidence/F-imports-review-3/needs-attention-selected.aria.txt`
  and `zoom-200-mobile.aria.txt`: the five options sort to the end of the list,
  after `Upload link expired`.

## Prerequisites

A content-designer decision. The reviewed reason strings themselves are a D15
content gate output and must not be re-worded without that gate.

## Proposed fix

One of, decided by the content designer:

1. Group the Reason options by the source or stage they belong to (`<optgroup>`),
   so the X entries sit under a visible source heading; or
2. Disambiguate the leading token **in the filter list only** — e.g.
   `X (posts): allowance used up` — leaving the row and inspector copy, where
   the source is already stated, exactly as reviewed.

## Acceptance

A named case in `apps/web/src/lib/status/imports.unit.test.ts` (option 2) or in
`ImportsWorkspace.browser.test.tsx` (option 1) fixes whichever shape is chosen,
and no reason string outside the filter list changes.
