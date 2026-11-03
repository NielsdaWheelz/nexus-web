# intake uncertainty under admission holds lacks behavior proof

at `1b63b5706`, intake `didNotRun` preserves an unanswered replay as unknown, and
its confirmation path distinguishes an unsent admission hold from an answered
refusal (`apps/web/src/lib/imports/intake.tsx`). the retained browser cases do not
qualify 401/426 after uncertainty or confirm-held after uncertainty. extension
native22 exercises another owner and cannot establish this contract.

misclassification could claim refusal for an import that already committed.
qualify the intake through actual lost answers and actual admission boundaries,
with stable identity/bytes and independent publication checks. hosted 401/426
may retire the document, but this is not globally unreachable:
`UnauthenticatedApiBoundary.tsx:25-42` retains installed/android and confirmed
local-root documents; share’s handler outside that boundary is a no-op.
`api/client.ts:201-211,286` reloads hosted426 only when reload is not held and
once per build. assess the native main/share and local-root ingress before
claiming an exact state unreachable. no controller injection,
synthetic response or borrowed extension result counts as resolution. source-only
limits require the spec's precise unreachable-state explanation in the pr.
