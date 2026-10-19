# release: imports, owed owner checks

status: shipped; owner checks owed
origin: the imports pane and import history (wire 3, migration 0288); shipped in
`e623be680` (schema 0292, wire 10) on 2026-10-17
area: release / imports

done: the wire-10 release ran the 0288 refusal query on its rehearsal copy and
the live transactional guard with writers stopped. its case 10 passed the
imports list, detail and history and one supported retry, without naming the
retry's kind (received status only, see
[wire10 evidence](wire10-qualification-evidence-not-retained.md); private plan
`2026-10-17/wire10-release/original-public-docs/release-wire10.md`).

owed: no release record shows these in production.

- a failed upload: retry upload with the original file publishes it, and remove
  removes another. include an expired upload.
- history with a reason filter shows the matched line, and the inspector's
  history opens on it.
- an import from before september shows the baseline lines.
- a repaired epub's history reads reprocessing accepted, if one exists.
- phone: the details sheet opens and closes.

delete this file once the owner has run these or waived them.
