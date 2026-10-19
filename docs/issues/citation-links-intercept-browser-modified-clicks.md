# citation links intercept browser-owned modified clicks

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: citations / workspace link activation

problem: citation anchors in chat and oracle handle control/meta/alt clicks as
workspace navigation and prevent their normal browser action. they may also
reveal a source before deciding whether a gesture should be handled.

evidence: `apps/web/src/components/ui/ReaderCitation.tsx:103-111` invokes the
custom activation before the standard anchor adapter. the chat callback at
`apps/web/src/components/chat/Conversation.tsx:103-108` checks only
`defaultPrevented` and uses the shift-only classifier; oracle at
`apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx:230-244`
dispatches a reveal first, then does the same. the canonical adapter explicitly
leaves these modifiers to the browser at
`apps/web/src/lib/panes/targetLinkActivation.ts:63-73`. source-confirmed; no live
execution.

prerequisite: classify the browser gesture once before issuing navigation or
source-reveal effects.

proposed fix: route rich citation anchors through the same adapter as ordinary
resource links, adding located-source data to a handled activation rather than
bypassing the gesture contract.

acceptance: plain click follows, shift-click forks, control/meta click and native
open-in-tab preserve browser behavior without moving existing readers. keyboard
activation has the same documented behavior across citation surfaces.
