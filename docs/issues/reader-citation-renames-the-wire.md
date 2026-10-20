# the citation chip renames wire fields for its callers

status: open · origin: resource references re-slice (Q17, N12), 2026-10-19 · area: chat web / citations

`apps/web/src/lib/resourceGraph/citations.ts` `toReaderCitationData` renames
`CitationOut`'s `ordinal` and `edge_id` for `ReaderCitation`; its callers are
`components/chat/AssistantMessage.tsx:109`, `components/dossier/DossierDocument.tsx:156`
and `app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx:301`. the chip
could take `CitationOut` itself.

impact: one more name for each wire field; about 20 lines.

left to chat web: the callers are chat, dossier and oracle files outside the resource
references slice.

resolved when: `ReaderCitation` takes `CitationOut` and the mapper is gone.
