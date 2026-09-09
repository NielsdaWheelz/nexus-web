# URL-source reuse accepts a new attempt over an in-flight one

**Status:** open (hazard; history now records it, the acceptance is unchanged)
**Origin:** Imports workspace cutover, Track B, 2026-09-08
**Area:** `python/nexus/services/media_source_ingest.py` (`_accept_url_source`,
`_find_reusable_url_media`, `_reused_url_attempt_status`)

## What is wrong

`_accept_url_source` reuses an existing X-thread, X-post, or YouTube media and
creates a new attempt whose status is `_reused_url_attempt_status(media)`:
`failed` when the media is failed, otherwise `succeeded` — including while the
media is `pending`/`extracting` with an in-flight attempt. The new attempt
becomes the latest one, so the running attempt's next publication phase fails
its fence (`newer_source_attempt_exists`), returns `{"status": "superseded"}`,
and never terminalizes itself: the media stays `extracting` under a `succeeded`
attempt that never ran.

Contract §3 asked Track B to verify that no acceptance creates a newer attempt
over an in-flight one without terminalizing it, and to record `SourceSuperseded`
in that acceptance transaction where one exists. That record now exists
(`_accept_url_source`, "in_flight" branch), so the inspector can say who
displaced the run; the stuck media itself is unchanged.

## Prerequisites

Decide the product behavior for a second submission of a URL whose media is
still being processed: return the in-flight attempt (as `accept_embedded_source`
does) or wait for it.

## Proposed fix

In `_accept_url_source`, when the reused media's latest attempt is in flight,
return that attempt with `idempotency_outcome="reused"` instead of creating a
new one (mirroring `accept_embedded_source`), and delete the in-flight
`SourceSuperseded` emission and this ticket together.

## Acceptance

Submitting the same YouTube URL twice while the first ingest runs yields one
attempt and one job; the media reaches `ready_for_reading`; no `Superseded` event
is recorded.
