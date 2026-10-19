# pdf passage positioning needs browser verification

status: open · origin: 2026-09-17 passage navigation cleanup; restated after the reader rewrite (pr2, 2026-10-05) · area: pdf navigation

a passage deep link (`#passage-<id>`) resolves through
`GET /media/{id}/reader-targets/passage/{id}` to page quads (or a page start) and
becomes one reader jump (`hostedReader.ts` `useReaderEntry` /
`useLiveReaderTargets` → `reader.inspect({kind: "quads"})`). the reader harness
covers pdf open, page buttons, internal links, zoom, selection and highlights,
but no pdf passage arrival: actual positioning on a passage is `NOT_RUN`.

acceptance: in a working media pane, open a passage after pdf mount and then a
different passage in the same pane. both target pages enter the viewport with
the passage near the reading line, the hash clears once, and navigation away
cancels pending work.
