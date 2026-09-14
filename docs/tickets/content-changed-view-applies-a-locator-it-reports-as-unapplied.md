# a ContentChanged view applies the device locator while telling the user it did not

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: hosted reader progress / handoff copy

## what is wrong

`apps/web/src/lib/reader/useReaderProgress.ts:306` classifies a `ContentChanged`
view with a matching row source as source-unavailable, but
`DocumentReaderSession` applies the device locator independently, so the reader
does move. the handoff surface then renders the `SourceUnavailable` sentence for
a position that was in fact applied.

## prerequisites

the accurate fix needs a **third** `sourceStatus` value (the position was
superseded but still applied) plus its copy in
`apps/web/src/app/(authenticated)/media/[id]/ReaderProgressHandoff.tsx`. adding
the hook half alone makes the copy worse, not better.

suppressing `initialLocator` is the cheap alternative and is wrong: the device
locator agrees with the selected generation, and refusing to apply it would trade
accurate copy for lost reading continuity.

## proposed fix

add the third status to the hook's union and the matching sentence to
`ReaderProgressHandoff.tsx` in one change, so the reader says what it did.

## acceptance

a `ContentChanged` view whose row source matches the selected generation moves
the reader and says so; one whose source does not match moves nothing and says
that. the two cases render different copy.
