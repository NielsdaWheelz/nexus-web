# offline reader repair inherits the import parse ceiling

status: planned postrelease; maintenance budget not yet qualified
origin: 2026-10-14 release r3 inspection and owner disposition
area: epub parser / maintenance

the complete read-only r3 inspection at `58c7ecae6` retained four real time
refusals at `python/nexus/services/epub_ingest.py:435`:

| media | production parse time |
| --- | ---: |
| `043e7f93-bff0-4e6d-8c2e-ff684288641c` | 30,140 ms |
| `20405d0e-4fda-4cc7-b5e0-04b6a8a724d6` | 64,376 ms |
| `228d14cf-120c-495c-9e5c-5a3383658843` | 56,328 ms |
| `e6b755eb-c744-4391-b6ec-2b3ed2553837` | 37,078 ms |

these failures do not pass. [the complete census](reader-source-notes-production-repair-pending.md)
is invalid for apply; production navigation/note metadata remains unrepaired.
remaining corpus repairs were explicitly deferred from the usable release.

`MAX_EPUB_ARCHIVE_PARSE_TIME_MS` is the import setting, default and maximum
30,000 ms (`python/nexus/config.py:272` at `58c7ecae6`). maintenance currently
reuses it; its suitability for offline repair is UNESTABLISHED. neither a
larger maintenance budget nor a requirement to finish every repair in 30
seconds has been qualified. archive, source and identity checks remain required.
at planning base `75b17c030`, `epub_ingest.py:770–775` checks elapsed time
after parsing; this acceptance budget does not terminate an overlong process.

profiles found repeated exact text/classification and structure work. preserved
local source work includes canonical commits `87e552c574ab9b4783e3f0e33fafcadd6d35c3d4`,
`b447b1fd7c91fb319df5d38e5d9fd1b7ea2cbd86` and
`ad56d5dbd64071897be26d1289f4eb3e51831386`; their local static/equivalence
proofs do not qualify a combined maintenance run. b447/ad56 were not integrated.
the performance worktree remains at `4c168245c` plus a preserved dirty patch.
its earlier combined normal runs returned in 29.767 s and 28.449 s; the third
refused at 38,517 ms (38.576 s call wall time). the first margin was insufficient
and the aggregate failed.
the later predicate reorder has only helper-output proof: 70,804 matching
anchor results and 15 controls. no final combined parser, immutable image,
restored-database apply or production qualification followed it.

evidence: `release/attempts/58c7ecae6/r3-full-inspection-v2/`, manifest
`8ef9c4048ebd396e0d2055afec86295ca9ac0cb68e76f6f7c766599efcc2eb49`;
`release/epub-performance-deferred-20261014T191354Z/`, checkpoint manifest
`e4e8af9c2aa9c5f720cef60a8d2a4dff7ba84bd7f257d34a7240fffe135f356b`.
local canonical proofs remain in `release/canonical-nfc-buckets-20261014/`,
`release/canonical-nfc-identity-20261014/` and `release/canonical-literal-text-20261014/`.

next: implement and qualify the [book-repair plan](../book-repair-plan.md).
it proposes a separate 120-second maintenance parse budget and a 180-second
invocation deadline plus five-second kill grace, off-host with bounded memory
and private temporary storage. these are candidates, not qualified limits.
normal import policy stays unchanged. retain explicit scope, source, generation,
saved-coordinate and identity fences; record any remaining refusal as unresolved.

acceptance: reviewed maintenance applicability and bounds; genuine source/output
proof; complete valid inspection, separately reviewed fenced apply and unchanged
reinspection. preserve real refusals until resolved; never synthesize a passing
plan from failed or partial input.
