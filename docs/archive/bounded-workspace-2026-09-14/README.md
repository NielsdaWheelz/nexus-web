# bounded workspace preservation index

status: work closed for now, 2026-09-14; implementation paused.
[replacement plan](../../cutovers/production-crash-replacement-plan.md) · [evidence audit](../../cutovers/bounded-workspace-evidence-audit.md).

all implementation, claude fixes, useful drafts and evidence remain on
`codex/bounded-workspace`, frozen at `d8d2851b0243c40a3868b313b33422efbc785459`.
[pr #250](https://github.com/NielsdaWheelz/nexus-web/pull/250) was closed as
superseded after preservation. no code or historical worktree was discarded.

this docs-only handoff carries the plan, audit and this index. the historical
implementation docs and code-containing archives stay on the frozen branch;
commit-pinned links preserve access without importing unmerged contracts or
roughly 27 mb of archive payloads into main.

| preserved material | contents |
|---|---|
| [full inventory](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/archive/bounded-workspace-2026-09-14/README.md) | recovery instructions, exclusions and provenance. |
| [hash manifest](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/archive/bounded-workspace-2026-09-14/manifest.json) | archive/member hashes, byte counts and original source locations. all four archives and 5,794 members were verified at preservation. |
| [receipt index](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/testdata/evidence/bounded-workspace-receipts.json) | 685 receipts and their original verdicts; all 941 indexed artifact references resolved. another 502 uncited run records and their referenced files are archived separately. |
| [historical docs](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/cutovers) | superseded specification, production diagnosis, source/runtimes dossiers, reviewer findings and trade-offs. |
| [historical tickets](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/tickets) | unresolved implementation and qualification findings; not automatically findings about current main. |

product source remains the paused `8f2e78c86d53808af8545f4c8d96c9429aa23a49`;
the preservation commit changes documentation and archives only. preservation is
not release qualification. the incident remains unresolved; no implementation,
merge, migration or deployment resumes without an explicit new instruction.
