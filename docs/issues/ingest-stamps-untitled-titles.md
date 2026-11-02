# ingest stamps placeholder titles as data

problem: ingest writes a placeholder into `media.title`, so a missing title is stored as
if it were literal, and the client's `untitled {noun}` never fires for these rows.

impact: a titleless epub is announced `book: Untitled EPUB`, in schema-flavoured caps,
with the format repeated. no surface can tell a real title from the stamp.

evidence: `python/nexus/services/epub_ingest.py:1003,1008` return `Untitled EPUB`;
`python/nexus/services/podcasts/feed.py:169` falls to `Untitled Episode`.
`apps/web/src/lib/workspace/presentations.tsx:168` composes `untitled {noun}` from a blank
title that these paths never produce.

proposed fix: store the absence and let the client's one composition name it, with a
migration for stamped rows, or record that the stamp stands. `media.title` nullability
is the real decision.

resolved when a titleless resource reads `untitled {noun}` on every surface, with no
stamped row left, or the owner records that the stamp stands.
