status: open
origin: 2026-09-14 bounded reader projection review
area: canonical text / svg

the epub sanitizer retains svg `title`/`desc`
(`python/nexus/services/epub_ingest.py:234`). backend canonicalization and
the browser dom cursor skip only script/style/noscript/template
(`python/nexus/services/canonicalize.py:70`,
`apps/web/src/lib/highlights/domTextCursor.ts:59`). svg metadata can therefore
enter canonical offsets despite lacking ordinary visible text. no user-facing
failure has been reproduced yet.

verify a retained svg title/description fixture through extraction, find and
locator application. define visible versus accessible metadata treatment before
changing canonicalization; existing locators cannot be silently reindexed.

acceptance: the fixture has an explicit, matching server/browser policy; find
results resolve to a supported visible or accessible target, and old positions
keep their provenance.
