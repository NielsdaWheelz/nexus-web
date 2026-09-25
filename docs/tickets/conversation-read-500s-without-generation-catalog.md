# conversation read returns 500 without a generation catalog

status: open · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: chat api

with no reachable codex catalog host, `GET /conversations/{id}/tree` raises an
unhandled `GenerationCatalogRefreshError` (500) while `/llm-catalog` maps the
same condition to 503. the conversation pane then shows "This pane couldn't
load" even for an empty conversation, so a local stack without llm credentials
cannot render any conversation (and the fork-actions check could not run).
related: [api startup](api-startup-requires-codex-catalog-availability.md).

fix: reading a conversation must not require a live catalog refresh; map the
unavailable catalog to the same typed unavailability the catalog read uses.

acceptance: with the catalog host down, an existing conversation renders its
history and reports generation as unavailable.
