# progressive search cutover

ship api, workers, hosted web and generated wire together; reload open clients.
preview requires `direct`, `lexical` or `hybrid`; full search requires `lexical`
or `hybrid`. old phases/cursors and semantic-unavailable success are removed.
there is no compatibility reader. this work retains main's wire 13; the released
web source `8a67e218ae28cedf89932d7feb13d5cffea05c60` used wire 11. recheck the
paired release before rollout and apply the once-per-release wire rule.

stop writers and take a verified backup through the existing deployment owner.
apply the normal migration chain through 0303 and verify exact head before
restarting the coordinated release. 0303 preserves ready passage/span ids,
embeddings and summaries; it adds lexical revision stamps and converts executable
note-job payloads. deleted notes' executable jobs become superseded successes;
terminal history remains. inconsistent ready materializations or notes without
index state refuse conversion and require explicit repair before retry. no
provider calls or automatic reindex occur. recovery restores the pre-release
backup and paired binaries; there is no downgrade migration.

no new env key or infrastructure is required. existing embedding credentials
enable related matches; configured api startup prepares local sdk imports before
readiness without network requests. missing credentials leave published text
searchable and expose related-match unavailability. prior schema/client release
prerequisites remain owned by [release-x-thread-imports.md](release-x-thread-imports.md)
and [release-x-articles.md](release-x-articles.md).

before release, require restored-corpus latency qualification within existing
resource limits; a timeout or missing provider is not a successful latency result.
after rollout, check direct/lexical/hybrid delivery, interaction-held refresh,
phase-bound continuation, source/page activation, mobile ime and announcements,
and text publication before embeddings. delete this issue after coordinated
rollout and owner checks. production execution is a separate owner action.
