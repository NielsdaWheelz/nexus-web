# failed media projections have no ordinary retry

status: open
origin: 2026-10-13 pane-controls live qualification
area: media intelligence / dossier recovery

a media projection that failed during a generation outage stays failed after the
runtime recovers. creating another dossier does not retry that prerequisite, so
the reader cannot obtain a generated revision through the ordinary actions.

evidence:

- the isolated epub's `media_summaries` row is `failed` with
  `error_code=runtime_unavailable`; its `media_unit_build` queue job is already
  `succeeded`. read-only receipt: `private-original-media-projection-db-evidence.json`.
- `python/nexus/services/media_intelligence.py:301` returns `ProjectionFailed`
  before `ensure_media_unit` can run; the suspended branch also returns early.
- `python/nexus/services/dossier/run.py:80` turns a failed prerequisite into
  `DependencyProjectionFailed`. the ordinary artifact head reports that failure.
- after normal enrollment, the real model catalog returned 200 and a chat
  completed. the ordinary dossier retry returned 202 in
  `real-runtime-generation-admission.json`; it then settled `Failed` with
  `DependencyProjectionFailed`, no active build and no revision, in
  `original-media-artifact-recovery-receipt.json`. private `fixtures.json`
  preserves the original as `mediaArtifact`.

prerequisite: retain the existing one-job-per-content-version and generation
charging guarantees. define an explicit owner-authorized recovery operation that
requeues a failed projection without duplicating active work; expose it through
the normal product action. do not repair projection publication with fixture or
database writes.

acceptance: cause a genuine projection failure, restore the provider, use the
ordinary recovery action, and obtain a ready projection and published dossier for
the same media content. repeated recovery cannot admit duplicate active work.

raw receipts and fixtures were disposable and removed after qualification;
[the durable record](../pane-controls-verification.md) preserves fixture ids,
normal runtime proof and the unrepaired prerequisite failure.
