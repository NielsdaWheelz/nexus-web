status: open
origin: 2026-09-25 notes writing adversarial review
area: vault page imports

the vault import checks `file.server_updated_at` against `page.updated_at`.
`_apply_marked_page_blocks` can replace the page's ordered targets, but
`replace_ordered_targets` changes the `outgoing_edges` lane without updating
`page.updated_at`. an old export with the same block ids and stale order can
therefore revert newer page links. evidence: `python/nexus/services/vault.py`
page gate and marked-block apply; resource graph order mutation owner.

prerequisite: export page and relevant parent `outgoing_edges` lane versions.
check those versions in the same serializable graph mutation transaction before
replacing order. preserve the page when any base is stale.

acceptance: import a stale export after reordering or changing links; it
returns an explicit conflict and leaves current links and order intact.
