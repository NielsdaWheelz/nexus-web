# x thread input migration rejects retained history

status: correction prepared; awaiting restored-chain qualification and the owner's
retention decision before production migration.

on the verified schema-0329 backup, migration
`migrations/alembic/versions/0330_x_thread_capture_input.py:40` aborts with
`0330 unexpected thread input` before migrations 0331 and 0332 can run. evidence:
qualification run `20261105-002933-0054a23393f8`, retained private `migration.log`.
the owning attempt is recorded there; no private source content belongs here.

the migration accepts only an empty payload or a single
`parent_source_attempt_id` key. the archive has 91 thread attempts: 77 historical
url inputs (`url`, `kind`, `post_id`, `library_ids`), 13 backfilled inputs
(`backfilled`, `media_kind`, `media_status`, `post_id`), and one empty input.
all 90 retained post ids agree with `provider_target_ref`; all 77 urls agree with
`requested_url`, their kind is `web_article`, and their destination ids are valid
uuids. eight inputs retain nonempty historical destination lists.

these are valid historical shapes: `e5428eb4f` wrote the url payload in
`services/media_source_ingest.py:191` and the backfill markers in migration
`0133_media_source_attempts.py:199`; `8c1d69f5d` migration 0136 added the retained
`post_id`. migration 0282 deliberately preserved them after moving acquisition
to authoritative columns. current supersession uses current holdings, never
historical destination lists. define the narrow conversion and its explicit data
effects; preserve acquisition targets and parent provenance, and grant no capture
authority to old url inputs. do not scrub, skip, or broadly accept unknown data.

the unreleased 0330 converter now validates these exact shapes and authoritative
column agreement before any update, retains a real parent, and writes only
`capture_input:null` / `parent_source_attempt_id`. the 91 original payloads are
preserved in a separate private archive; no production rows have changed. unknown
keys, malformed destinations and inconsistent targets still abort.

resolved when the exact backup migrates through the corrected chain, preserving
all valid historical source evidence and refusing genuinely malformed input.
