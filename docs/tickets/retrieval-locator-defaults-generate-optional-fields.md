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

fix (in the locator/search slice): write every key, backfill stored locators
(message retrievals, resource edges, events) with explicit nulls, then drop the
defaults.

resolved when: no locator field generates as optional and stored locators load
without defaults.
