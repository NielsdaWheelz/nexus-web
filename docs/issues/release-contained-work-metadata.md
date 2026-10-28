# contained work metadata release

release the [piece bibliography contract](../modules/media-metadata.md) with
migration `0321` after `0320`. this record owns release operations, not
implementation proof.

- census child edition scalars, child publisher credits and unpublished candidate
  publisher observations before release. exact duplicate scalars are convertible;
  discrepancies require evidence-backed, backed-up owner repair. retain exact
  affected ids and repair instructions privately; never promote a child claim to
  its source automatically.
- validate retained bibliography result shapes, including jobs for deleted media.
  migration adds explicit null reports, clears only proved duplicate child edition
  scalars, enforces the constraint and updates affected revisions/search projection.
- stop admissions and drain/stop old writers through the normal controller; old
  binaries must not publish after cutover. use the existing verified backup/restore
  and exact-head procedure. no old-result decoder or mixed-version runtime.
- land the pinned search-unavailable provider and matching kernel/memory pins
  ([llm-tools #27](https://github.com/NielsdaWheelz/llm-tools/pull/27),
  [llm-agent-kernel #22](https://github.com/NielsdaWheelz/llm-agent-kernel/pull/22),
  [universal-memory #3](https://github.com/NielsdaWheelz/universal-memory/pull/3))
  before release; verify the deployed workers use the paired revisions and report
  unavailable search as a typed tool failure.
- pair api, web and native clients at wire `17`, sharing the pending podcast and
  local-first cutovers after the shipped wire `16` release. recheck actual
  activation before release; add no second bump without a newer paired release
  boundary. use matching backup/binaries for rollback.
- verify a real introduction's independent bibliography, source-derived edition
  display, source-discrepancy reporting and explicit old-source rediscovery after
  deployment. no corpus backfill or automatic per-piece research.

delete when preflights, conversion, paired activation and deployed acceptance are
recorded with the release. no deployment or live repair is authorized by this note
alone.
