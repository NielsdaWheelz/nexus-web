# source refresh capability disagrees with refresh admission

status: open, source-qualified; no runtime probe.
origin: 2026-10-09 python dead-code sweep (branch cleanup/python-dead-code, base 407fcc735).
area: ingest / media capabilities.

the `can_refresh_source` capability and the refresh route decide the same
question with two different rules.

- `python/nexus/services/media.py:103-149` `_SOURCE_REFRESH_AVAILABLE_SQL`
  hand-lists source types. the list predates email ingest (2026-06-04 vs
  2026-07-10) and omits `email_message`, so email media never advertise refresh.
  its storage-error gate lists `E_SIGN_UPLOAD_FAILED`, `E_STORAGE_MISSING`,
  `E_STORAGE_ERROR`.
- `python/nexus/services/media_source_ingest.py:236-247`
  `_reacquisition_restriction` (used by `refresh_source_for_viewer`) accepts
  `email_message` and refuses only on `E_SIGN_UPLOAD_FAILED`/`E_STORAGE_MISSING`
  for `NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES`.

so the api refreshes an email the ui hides the action for, and the ui hides
refresh after `E_STORAGE_ERROR` that the api would admit.

fix: decide the intended rule, then derive the sql predicate from
`media_source_types` sets and the same error-code set the admission uses, so
one owner states it.

acceptance: one source-type set and one error-code set feed both the
capability sql and the admission; an email media's capability matches what
`POST .../source/refresh` does.
