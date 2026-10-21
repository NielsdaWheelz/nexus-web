# search readiness loses to queue settlement

status: open; source-confirmed, crash-window reproduction pending.
origin: 2026-10-21 progressive search specification.

`python/nexus/services/media.py:133-134` reports suspended whenever a dead index
job exists, before considering committed index readiness. imports similarly
classifies a dead index job as needing attention before checking completion
(`python/nexus/services/imports.py:186-190`).

impact: completed index publication followed by failed queue settlement can
appear unfinished and invite unnecessary repair. an index transaction and its
later queue acknowledgement are distinct facts; committed current readiness or
the explicit no-text/ocr-required outcome must govern the capability.

reproduce in an isolated runtime: interrupt after ready publication commits but
before queue acknowledgement, then exhaust/reclaim the remaining attempt.
verify media detail, processing snapshot and imports against the actual index.

resolved when current ready publication and required model identity, or completed
no-text/ocr-required outcomes, win over dead/running settlement. incomplete
revisions must still show their real work state. retrying committed completion
must preserve ids/timestamps and avoid repeated effects.
