# note editor references cannot name their media kind

problem: authored stubs carry no media kind, so a media reference in the note editor,
local search or a palette local match can only draw the generic page and the noun source.

impact: one book can be a codex in a remote row and a leaf in a local one, including in
the same pane. a palette row can swap drawing under focus when a local match resolves
remotely.

evidence: `apps/web/src/components/notes/OutlineEditorRow.tsx:57`,
`app/(authenticated)/search/SearchPaneBody.tsx:375`, `lib/nexus/rows.ts:270`.
`ResourceProjection` has no kind (`node/authored/src/types.ts:49`). `capture.kind` looks
close and is not: it is a free string holding schemes, media kinds and `x_capture`
(`links.ts:129`, `ShelfReader.tsx:159`, `CapturePaneBody.tsx:102`), typed `str` at
`schemas/authored.py:154-155`, and never projected (`queries.ts:56,85`).
`resource-references.md:111` bars markers from fetching.

proposed fix: project a closed media kind onto authored resource stubs at capture,
with a format change and backfill through `node/authored`, or accept the split. do not
build on `capture.kind`.

resolved when a media reference shows one medium on every surface, or the owner records
that the split is acceptable and this file is deleted.
