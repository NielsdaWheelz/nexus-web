# recent imports order by anyone's latest attempt, not the viewer's acceptance

status: open · origin: 2026-11-02 import acquisition (slice 1) adversary · area: imports

`GET /imports?view=Recent` sorts on `ImportItem.accepted_at`, which for a `media:`
row is the creation time of the media's latest source attempt by any reader
(`python/nexus/services/imports.py`, `msa` lateral `ORDER BY LATEST_ORDER_SQL LIMIT 1`
and `accepted_at` in `import_work`). so:

- a superseded own import (a link that redirected onto an article already held,
  often the viewer's own older import) sorts at the winner's latest attempt, not
  at the top. the viewer's attempt survives only as a `media_source_supersessions`
  row, which has no timestamp.
- another reader's retry or refresh of shared media the viewer imported lifts it to
  the top of the viewer's shelf.

impact: slice 2's shelf reads five rows (`fetchImportPage("view=Recent", null, 5)`).
a just-imported redirect can be missing from it, and a shared import can appear there
though the viewer did nothing. no case exercises supersession.

fix, afaict: order Recent by the viewer's own latest acceptance (their newest live
attempt or upload session), which needs a time on `media_source_supersessions` for
the superseded arm. idk whether the shelf should instead drop superseded rows.

resolved when: a redirect into a held article tops the viewer's Recent, and another
reader's refresh of a shared import leaves the viewer's order unchanged.
