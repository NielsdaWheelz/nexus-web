# episode metadata release

status: implementation qualified; paired release remains open.
contract:
[resource references](../modules/resource-references.md).

episode bibliography reuses the released required nullable `MediaSummaryOut.show`
field. catalog format 3 rejects format-2 bytes. its gates are
`python/nexus/schemas/offline_catalog.py:139`,
`apps/web/src/lib/catalog/provider.tsx:50` and
`apps/android/app/src/main/java/app/nexus/android/CatalogStore.kt:337`.
format 2 is incompatible, even at the current wire revision.

before release:

- qualify the shared summary and format-3 producer/readers together.
- released `c6c90343c` supplies `show` at wire 18. the catalog response literal
  changes from 2 to 3 and rides reader-opening's pending wire 19. wire-18 clients
  receive the existing 426 update-required response; do not bump again before
  that paired release.
- pair api, workers, hosted web, android packaged bundle/native reader and firefox
  extension at wire 19 from the same release source. the extension manifest is
  1.0.6, above released source's 1.0.5; sign/publish the rebuilt artifact through
  the current release lane. retain the previous complete artifact vector.
- qualify format-2 refusal, successful online rebuild and offline cold start with
  format 3 on the real disposable android runtime. retain existing rebuild feedback;
  do not purge downloads or authored data. no database migration is required.
- preserve uncommitted writing and pending authored commands before the paired
  update. restart browser clients to retire old shared workers; do not clear data.
- tell the owner that saved browsing needs an online rebuild after updating.

resolved when the paired release and catalog rebuild are qualified, with actual
observations in the pr. rollback pairs prior hosted/native artifacts and rebuilds
their catalog format online; neither direction adds a compatibility reader.
