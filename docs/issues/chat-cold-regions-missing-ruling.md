# cold chat regions have no waiting presentation

problem: three cold reads leave their object region without the required ruling.

impact: the user cannot distinguish a slow initial read from an empty or inert region; the specified long-wait `still opening` and delayed opening speech cannot occur there.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`:
- `apps/web/src/components/chat/ConversationDestinationOverlay.tsx:115-132` renders failure or empty state, then an empty list. `components/collections/useCollectionReadFeedback.tsx:80,84-95` returns only an outcome announcement, not a ruling.
- `apps/web/src/components/chat/ChatContext.tsx:102-125` renders tools and metadata while loading, with neither list nor ruling.
- `apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx:133-148,234-287,411-413` leaves only the folio frame and ellipsis while detail is loading. skeletons require an already-read pending/streaming domain job, so they do not cover the cold read.

resolution: put the existing `Ruling` in each cold empty region, retaining oracle’s separate long-job presentation. exact new local wording: none; shared ruling supplies `opening` and `still opening`. prove delayed cold reads show the ruling, quick reads do not paint it, and refreshes keep shown content quiet. no new status owner or component abstraction.

status: source finding only; no runtime timing was measured. correction and behavior qualification remain pending.
