# URL-source reuse joining an in-flight attempt has no proof

**Status:** open (behavior fixed; proof missing)
**Origin:** Imports workspace cutover, Track B review, 2026-09-08
**Area:** `python/nexus/services/media_source_ingest.py` (`_accept_url_source`)

## What is wrong

`_accept_url_source` used to create a new `succeeded` attempt over a reused
X-thread/X-post/YouTube media whose latest attempt was still in flight, so the
running attempt lost its publication fence and the media stayed `extracting`.
It now returns the in-flight attempt with `idempotency_outcome="reused"` (the
same shape `accept_embedded_source` uses) and records no `SourceSuperseded`.

No named case exercises that branch: submitting the same URL twice while the
first ingest runs.

## Prerequisites

A URL acceptance fixture that does not contact a provider (the X/YouTube
resolvers run at acceptance time).

## Proposed fix

Add one named case to the URL-source acceptance owner proving that a second
submission during an in-flight run yields one attempt and one job, the media
reaches `ready_for_reading`, and no `Superseded` event is recorded.

## Acceptance

The case is green, and a fault that restores the old `create_attempt` branch
makes it fail.
