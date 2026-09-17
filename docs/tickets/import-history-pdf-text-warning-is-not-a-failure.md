# pdf text warnings share the failure vocabulary

status: open
origin: 2026-09-08 imports cutover, track a review; updated 2026-09-17
area: media processing state and import history

`mark_stage_warning` in `python/nexus/services/media_processing_state.py` writes
`E_PDF_TEXT_UNAVAILABLE` to `media.last_error_code` on successful publication
of a readable pdf with no extractable text. `failure_stage` and `failed_at` are
also set, although `processing_status` stays `ready_for_reading`.
`SafeFailureCode` in `python/nexus/schemas/import_history.py` includes this
warning, and source-attempt publication can copy `media.last_error_code`.

the browser already renders the honest wording, "imported without selectable
text," with no recovery offer. the shared storage and failure vocabulary still
permit a warning to be treated as a failed attempt; the former follow-up's
proposed assertion did not fix that representation.

prerequisites: inspect current warning publication and attempt-history writes.
keep nonterminal warnings separate from terminal failure state, or make the
publication owner explicitly exclude this warning from failed events.

acceptance: manually importing a readable pdf without extractable text shows
complete with its warning, and its recorded history contains no failed event
whose code is `E_PDF_TEXT_UNAVAILABLE`.
