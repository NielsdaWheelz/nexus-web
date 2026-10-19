# quoted-passage source links discard shift-click

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: chat / source activation

problem: quoted passages above the composer and in sent messages cannot fork a
source pane with shift-click, unlike ordinary workspace links and citations.

evidence: `apps/web/src/components/chat/QuotedPassageCard.tsx:81-82,115-119`
accepts only the selection in `onOpen` and drops the click event. its callers at
`apps/web/src/components/chat/Conversation.tsx:313-314` and
`apps/web/src/components/chat/ChatSurface.tsx:184-188` consequently activate with
no event; `Conversation.tsx:103-108` defaults that to follow. source-confirmed;
no live execution.

prerequisite: use the existing workspace gesture and follow/fork contract.

proposed fix: render the source through the shared resource-link activation
primitive, preserving its immutable quote locator and click disposition.

acceptance: ordinary click opens the saved quote target; shift-click creates a
new source pane whether or not another copy exists. both composer and sent
message quotes retain the original snapshot extent after the live highlight is
edited. browser link and keyboard behavior matches other resource references.
