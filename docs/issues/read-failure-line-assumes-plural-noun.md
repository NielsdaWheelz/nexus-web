# the offline read line breaks on a singular noun

status: open · found 2026-11-12 by reading at `09c14e68f` · area: web / failure copy, librarian composer

`TRANSPORT_LINES.Offline.read` builds `${noun} load when you’re back online.` and
documents itself as taking a plural noun (`apps/web/src/lib/api/failure.ts:59,66`).
the draft reference passes `noun="this quote"`
(`components/chat/ReferenceFigure.tsx:124`), so offline it reads
`this quote load when you’re back online.` the other `Failed` callers pass plurals
(`this item’s details`, `this pane’s contents`).

impact: one ungrammatical line in the composer.

resolved when the draft passes a plural noun, or the line agrees in number.
