# chat rewrite is over its line budget

status: open · origin: 2026-10-04 chat rewrite · area: chat / reauthoring

The chat rewrite measures 5,607 formatted lines (web 5,332, python tree owner
275) against a 5,000 cap. Of the design's cut list only cut 4 (picker paging)
is taken. The others are held by owner decisions: index sort (−~100; "the index
behaviour stays"), the Details citation and context-ref lists (−~25; "Details
stays"), fork rename (−60 incl. python; "fork titles kept") and the docent
(−180 plus a python action-snapshot change; "docent stays"). A first pass took
the index and Details cuts and measured 5,464; review restored both.
Formatted counts (prettier 3, ruff format), budget in parentheses:
`lib/chat`: wire 93 (60), tree 188 (140), selection 153 (110), drafts 189
(140), runTail 124 (110), readerIntent 58 (80), conversationIndex 101 (110),
messageActionIntent 77 (70); `components/chat`: conversationStore 434 (360),
Conversation 284 (240), ChatComposer 331 (250), GenerationPicker 255 (150),
ChatSurface 266 (170), useChatScroll 276 (220), AssistantMessage 341 (230),
AssistantTrust 246 (200), Forks 226 (200), QuotedPassageCard 156 (120),
ConversationDestinationOverlay 164 (130), ContextRefsPanel 99 (70), Docent 137
(140), conversationFind 90 (85); ConversationsPaneBody 399 (300); css 280 +
180 + 185 (330 + 170 + 150); python service 222 (240), route 53 (45).

impact: 607 lines (12%) over the cap; no behaviour impact.

resolved when: the owner accepts the overrun, or releases held cuts, or a later
pass finds an honest simplification that brings the measured total to 5,000 or
less.
