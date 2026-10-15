# release image cache consumes the disk reserve

status: open
origin: 2026-10-14 x-title corrective release, pr 611
area: deployment / host storage

`3a80349b8` passed the 2-gib preflight floor, then image pulls left
1,460,740,096 bytes free at `23:36:11Z`. the controller completed with healthy
services; its preflight does not establish the post-pull reserve. accumulated
unreferenced application images consume that reserve. no volume, backup or
credential-state deletion is authorized by this finding.

define bounded retention of immutable application images at the release owner,
preserving every running/stopped container reference and recovery requirements.
measure the reserve after pulls and before handoff; refuse or perform the
explicitly owned cleanup before accepting the release. use no global prune.

acceptance: consecutive real releases retain at least 2,147,483,648 free bytes
after pulls, preserve referenced images and durable volumes, and record exact
cleanup/provenance. this release's selective manual cleanup is not that contract.
