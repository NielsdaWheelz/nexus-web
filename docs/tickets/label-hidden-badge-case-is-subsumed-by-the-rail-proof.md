# The label-hidden badge case is subsumed by the collapsed-rail proof

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain W2, 2026-09-09, while
establishing `components/appnav/NavRail.browser.test.tsx`
**Area:** `apps/web/src/components/imports/ImportsWorkspace.browser.test.tsx`

## What is wrong

`ImportsWorkspace.browser.test.tsx::"keeps the capped count painted when the
chrome hides its label"` renders `ImportsBadge` alone in a bare `<a>` and asserts
the count is painted rather than left in the screen-reader-only box. The new
`NavRail.browser.test.tsx` now asserts the same thing in the chrome that branch
exists for — the collapsed rail — and additionally asserts where the chip lands
and that the link it counts for contains it. The older case can no longer fail for any
reason the rail case would not fail first, so it is a duplicated fragment
(`docs/local-rules/testing-standards.md` §§13–14: one canonical owner per
boundary).

## Prerequisites

None. It was left in place because chain W1 owned
`components/imports/**` while this proof was written.

## Proposed fix

Delete that one case from `ImportsWorkspace.browser.test.tsx`, keeping the two
badge-semantics cases there (the `99+` cap beside the exact accessible count, and
the unloaded/zero distinction), which the rail proof deliberately does not
restate.

## Acceptance

`vitest:apps/web/src/components/imports/ImportsWorkspace.browser.test.tsx` and
`vitest:apps/web/src/components/appnav/NavRail.browser.test.tsx` both stay green,
and no case renders `ImportsBadge` outside a chrome that really hosts it.
