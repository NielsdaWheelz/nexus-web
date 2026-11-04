# native transcript contention blocks retry

an arbitrary http409 from a transcript download becomes `Changed`. android and
the downloads pane then exclude that extra from retry, even when database
contention caused the response. downloaded audio remains playable, but the
transcript cannot recover through its existing retry control.

evidence at feedback-homes a7dcd4898: `Transfers.kt:188,247-251` maps the origin
response by status alone; `OfflineJobService.kt:282-283` publishes that reason;
`OfflineStore.kt:293-307` excludes `Changed` from `retryExtras`.
`DownloadsPaneBody.tsx:120,136` also omits the retry control. these files live
under `apps/android/app/src/main/java/app/nexus/android/offline/` and
`apps/web/src/app/(authenticated)/downloads/`, respectively.
`python/nexus/api/edge.py:93-99` emits409 `E_RESOURCE_CONFLICT` for database
contention. changing the descriptive copy does not repair this recovery policy.

resolve by distinguishing an authoritative captured-source mismatch from a
retryable technical refusal at the native transfer boundary, preserving the
captured package and bytes. qualify a real busy/refusal followed by successful
exact-package retry, and retain non-retryable handling for a proven mismatch.
this is a source finding; that device journey has not run.
