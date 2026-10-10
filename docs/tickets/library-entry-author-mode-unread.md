# library entries carry an author mode nothing reads

status: open · origin: 2026-10-10 authors reauthor (spec §5) · area: libraries / wire

`LibraryEntryMediaOut.author_mode` is serialized by the library-entries read and
mapped into `lib/libraries/entryListItem.ts:20,59`, but no web code reads it: the
authors editor loads `author_mode` from `GET /media/{id}` itself.

impact: an unread wire member and a mapping kept only for it.

fix: drop `author_mode` from `LibraryEntryMediaOut` and its web mapping in one
paired api/web change (the library slice owns both files).

acceptance: the generated wire and `entryListItem.ts` no longer mention
`author_mode` for library entries; the library pane is unchanged.
