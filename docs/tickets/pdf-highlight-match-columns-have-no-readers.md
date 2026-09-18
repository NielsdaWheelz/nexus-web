# pdf highlight match columns have no readers

status: open · origin: 2026-09-17 package typecheck cleanup, base `352653689` · area: pdf highlight schema · oi-168

`HighlightPdfAnchor.plain_text_match_status`, `plain_text_start_offset`, and
`plain_text_end_offset` appear in current runtime code only as ORM declarations
and two write sites in `pdf_highlights.py`. no runtime consumer was found;
highlight projection uses geometry and quote context. the same-named JSON selector
keys in content indexing are a different contract.

prerequisite: verify all SQL consumers and deployed maintenance entrypoints before
dropping persisted data. then remove the three columns, their writes, and orphaned
constraints in one sequential migration. retain prefix/suffix computation and exact
quote/geometry behavior; assess whether match-status computation remains needed.

acceptance: migration succeeds on populated fixtures, no references to the removed
columns remain in current runtime code, and public pdf highlight create/update/read
behavior is preserved.
