# retrieval locator defaults generate optional fields

status: open · origin: 2026-09-28 cleanup pr-08 (cleanup/dossier-latest-revision) · area: search / resource graph / typed wire

the `RetrievalLocator` variants in `python/nexus/schemas/retrieval.py:322-460`
keep `= None` defaults (`media_kind`, `section_id`, `text_quote_selector`,
`prefix`, `suffix`, `title`, `display_url`, `accessed_at`). typed routes whose
closure reaches a locator (the dossier head, via `CitationOut.locator`) therefore
generate `media_kind?: string | null` and similar in
`apps/web/src/lib/api/wire.gen.ts`, against docs/local-rules/typed-wire.md.

the defaults cannot simply go: stored locators are written with
`exclude_none=True, exclude_defaults=True` (`retrieval.py:538-560`) and
revalidated through the same union, so existing rows omit those keys.

current rule correction (2026-10-03): an always-serialized output view can
declare serialization defaults required while retaining constructor defaults,
so output precision does not itself require a stored-locator backfill. shared
retrieval input/storage models still compact None/default keys; do not flag
them globally. this reader slice leaves their genuine omission contract and
this follow-up open.

fix: census remaining output closures and apply the requiredness setting only
to selected always-serialized output views. preserve compacted input/storage
omissions; backfill only for an explicitly selected stored-contract change.

resolved when: always-sent locator output keys are required in the generated
schema and compacted stored locators retain their existing load/replay behavior.
