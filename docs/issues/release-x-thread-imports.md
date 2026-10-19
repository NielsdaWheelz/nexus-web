# x thread import cutover

schema 0293 replaces aggregate x snapshots and copied thread fragments with
canonical post sources and ordered composition. it preserves published media ids,
filings, annotations and captured wording. ambiguous source ownership, contradictory
revision evidence and proved disconnected documents stop the transaction with exact
repair identifiers. there is no compatibility reader or automatic thread merge.

the recent 0292 backup has completed the actual migration and current reader/map
rehearsal on the isolated mac database. its initial migration correctly refused
missing normalized evidence for media `8e08157a-2584-41fd-a5e0-8ffe4bb9a415`
(revision `2078677820671459613`) with unchanged durable rows and schema. after
independent source review, exactly one normalized snapshot was inserted on that
LOCAL restore. the pinned historical inline renderer and attributed source regions
match the entire saved render exactly. the repair retains the original successful
attempt and leaves historical enumeration unknown; coverage and membership check
time remain null. no frozen evidence was repaired or rewritten.

the local cutover retains all 65 native publication ids, including 30 threads and
35 canonical singletons, and all existing filings. it creates 61 canonical posts
and converts three ordinary wrappers. all 129 affected publications pass current
reader/map reads. 76 highlights retain their frozen fields, 21 citation captures
retain their wording and attribution, and all 92 cursor rows survive; two positions
are explicitly unresolved. the five recovered inline highlights now belong to
existing quote owner `eb46ae53-7268-4c68-8439-331a937aeaf8`; its generated footer
position remains unresolved. discarded derived indexes have pending rebuild jobs.
there is no remaining blocker in this local rehearsal. production was not changed:
its current inventory, any required source-record repair, and the execution preview
still require deliberate production review and separate authorization.

before release:

- stop api, worker, scheduler and every other database writer. settle x source
  attempts and their jobs; resolve active derived jobs and teardown claims for
  affected publications. the migration takes nonblocking table locks and refuses
  unsettled work; those locks do not replace stopping old processes.
- retain and verify a recent production backup. restore it on the mac at 0292 and
  rehearse the ACTUAL migration and paired reader. an older 0236 backup is not a
  rehearsal of this cutover. the qualified backup has source `8a67e218ae28cedf89932d7feb13d5cffea05c60`,
  1,296,042,015 bytes, sha256
  `f92a4a68df62055264e89a9bd378833c3b0208beae72e68b738c2a51d849e702`.
- inspect the migration's repair inventory. deliberately repair missing normalized
  evidence, conflicting exact aliases/authors/references/attachments, mixed-source
  selections whose owner cannot be proved, and falsely combined components. any
  bounded provider evidence gathering happens before migration; migration itself
  performs no network requests.
- give the owner the promised production impact preview BEFORE execution: exact
  affected media ids, retained singleton/thread ids and filings, canonical post
  allocations, annotation/evidence moves, unresolved cursors, discarded derived
  fragments/index rows, scheduled rebuilds, and all blockers. obtain production
  execution authority separately. preserve the content-free local exact-id impact
  inventory and reviewed repair artifacts before removing temporary qualification
  files; the local packet is `.nexus-local/x-thread-release/`. local newly allocated ids describe the rehearsal; a separate production
  run allocates its own ids.
- include ordinary articles with x embeds in that preview. their old generated
  captions copied foreign preview text into parent source offsets. conversion
  removes only proved x figure descendants, preserves article words, prepares
  exact zero-width slots, transfers source-proved foreign annotations and remaps
  article annotations/cursors. empty authored text is valid when slots remain.
  ambiguous preview ownership stops conversion; an unproved position becomes
  unresolved with its old excerpt. copied preview metadata is discarded.
- pair backend, hosted web, android and offline consumers at wire 12. the released
  android-v0.3.4 client uses wire 11; refuse its writes. regenerate and qualify the
  shared wire and offline cursor format. android's one-time `format_version: 2`
  envelope conversion wraps an old pending locator with `adopt_unresolved: false`;
  it preserves baseline, position, pending writes, frozen evidence and audio.
  verify restart idempotence and refusal of stale synchronization. the shelf
  refuses incompatible cached text bytes and offers manual remove/redownload;
  envelope conversion does not delete them. durable positions are retained.
  there is no old text-document decoder. do not advance the wire a second
  time in this release. pending old offline writes must fail their generation and
  revision checks rather than erase an unresolved position.
- after execution, verify the release candidate's exact alembic head, absence of the old snapshot
  table/provider uniqueness index, canonical source-attempt ownership, preserved
  filings and frozen evidence, source-correct annotations, honest null lineage and
  historical check times, containing publication generations, and reindex jobs.
  verify reads before restarting writers. an aborted transaction leaves 0292;
  recovery after a committed cutover requires the verified backup.

installed apk/device acceptance remains NOT_RUN; actual jvm store/synchronization
and web/public/shelf qualification do not establish installed-device behavior.

remaining release work is the current production inventory and reviewed impact
preview, coordinated client acceptance and separately authorized production
execution. production migration and client rollout are NOT_RUN by this change.
