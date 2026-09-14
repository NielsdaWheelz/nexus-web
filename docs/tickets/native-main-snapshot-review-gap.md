status: open
origin: 2026-09-14 bounded workspace review; known native snapshot `905f5b7f52`
area: native verification provenance

main contains changes beyond the reviewed anchor-preparation cut:
`OfflineReadingStore.kt` adds free-space admission and changes sync/defect reporting;
`OfflineReaderPublicationVerifier.kt` adds origin-based find admission;
`OfflineReaderPublicationFixture.kt` changes range-window and boundary construction.
the current native agent did not author those changes in this resumed turn.

preserve the edits, establish their contracts and review their complete diffs.
keep them out of the current narrow snapshot until reviewed. the invalid unit-edge
rule has its own ticket. no receipt for the older snapshot attests these bytes.

acceptance: reviewed ownership and contract disposition, followed by applicable
behavior/sensitivity proofs over the final exact source and fixture bytes.

root independently reviewed the store and synchronizer deltas: per-media
defects preserve pending intent and allow other writers to continue; an
unrecognized accepted cursor remains a durable conflict. the disk check is an
availability preflight, not a reservation or expansion bound. two real sqlite
lifecycle cases now assert pending/source/baseline conservation after reopen;
their sensitivity is pending. algorithm-only outcome strings do not close it.

word-origin review and both auxiliary sensitivities passed `87bdfdf09a940a3a`
and `fb24cd882f6dc595`, followed by original canonical `5fd3129c60a0e320`.
the range fixture's separate render-text correction passed its original
byte-volume fault replay `e509f4ce9c66d74f`. older snapshots do not attest these
final source and fixture changes.

HTTP snapshot audit also found prior main-only changes in
`OfflineReadingOriginClient.kt` (clock injection, named constants and polling
comment), `OfflineReadingOriginClientTest.kt` (clock-bound cases and account
attestation) and its `OfflineReadingAccountAttestor` constructor dependency.
these are not part of the progress HTTP catch correction. root independently
reviewed their exact source/test diffs and approved the source contracts,
including a positive compatible minimum bundle. actual pre-fix http receipt
`cef05c4358410726` finds zero was accepted. the reviewed clock and attestation
deltas are now in the selective native snapshot; their independent behavioral
sensitivities remain pending.

current evidence: actual HTTP canonical `c519411148257963`, expiry auxiliary
`f63403947d09106b` and account-schema auxiliary `9a79ae9a464f7e7a` pass.
real sqlite isolation `80fd551e1850b63a` and wrong-ack conflict
`c0aad7258a56c817` pass with the reviewed source. the lifecycle's disk-preflight
case also passes in both candidates. exact canonical lifecycle restoration and
replay remain queued after the separate newly discovered retirement correction.

2026-09-14 inventory against isolated `6c5ee6a56d` finds five additional
uncopied deltas. `OfflineReadingLegacyUnits.kt:195–211` deletes source html/list
rows and html/text checkpoints after converted-fragment commit, then deletes
the fixed-width spool; the existing maximum-source proof still observes those
rows after conversion. `OfflineReadingModels.kt:303` adds
UpgradeBlockedByStorage and calls preflight a reserve.
`OfflineReadingTableHeadersTest.kt:214` replaces measured workload sizes with
256 unless the new `nexus.capacity.offlineReadingTableHeaders` property is true.
no typed controller owner for that property has been established by this review.
these source/contract changes are not in any current native receipt.

smaller uncopied deltas: `OfflineReadingStateCodec.kt` narrows missing kind to
its existing malformed-input error; `OfflineReadingInstalledAccessTest.kt` adds
permission-stimulus and not-Ready assertions. all five exact deltas are retained
as `/tmp/<filename>.uncopied-native-delta.diff` for independent review. the
current queued retirement/max-atom work excludes them; no pins were refreshed.

git provenance: the exact current units, state-codec, installed-access and
table-header bytes already appear in root's full-source snapshot `195c9b0102`
(2026-09-14 05:04 UTC). the exact model bytes first appear in publication's
snapshot `21f24bdcb7` (06:46 UTC). these snapshot commits preserve source, but
do not identify the original edit author or establish independent native
review/execution. searches of the current cutover progress and tickets found
no earlier explicit disposition for these five deltas. the table workload
property occurs only in its test; no controller or gradle binding selects it.

root's independent disposition: removed the unused storage variant and restored
all original table-header measurement sizes. accepted state-codec malformed-kind
normalization and the stronger installed-access stimulus/not-ready assertions
for focused replay and exact owner review. fragment-scratch cleanup remains
unqualified: review the completed-checkpoint/unlink crash gap and deterministic
html/table reconstruction after candidate-directory loss, then prove those
boundaries with original-source/published-output oracles.

original lifecycle canonical now passes `f005f6ef84910801`, following all three
separate durable-progress and retirement auxiliaries. remaining review-gap work
is the approved missing-kind/access replay and scratch-cleanup execution. the
scratch source and both proof deltas are independently approved; its original
canonical and checkpoint-retention auxiliary remain pending.

raster run `7a164d1f5296769c` is a deferred selection, not execution evidence:
its selection names `android-host` with `deferred_to: full`; the capability list
contains no android-host execution. do not count the workflow's pass as a raster
proof. an actual native capability must run before claiming decoder qualification.

additional audit against `a554382764` found storage-specific native/web
availability, shared store/transfer clock wiring, scheduler commentary, blanket
NoSuchElementException catches, playback header-error precision and device
fixture changes. root reviewed their exact diffs. removed the unsolicited
storage variant/set and only its web case, restoring lifecycle `c4e1b794...`
and shelf `28329197...`; removed both redundant exception catches. the remaining
clock/schema/comment/playback changes are reviewed. device fixture now resolves
the actual descriptor first-unit key and explicitly rejects an unsupported SDK.
source inventory is `/tmp/native-reviewed-replay-source-list.json`; native
execution still excludes this set while units proof `a554382764` is active.

2026-09-14 second inventory guard stopped before copying four changed owners:
OriginClient `c895c680...`, Store `402adc55...`, TransferJobService `3ba22fe8...`,
LifecycleTest `77e8e55b...`. new source introduces capacity refusal/requeue and
durable conversion-failure columns/policy; the rejected storage-specific set
also reappeared. author/review not established. exact diffs are preserved in
`/tmp/OfflineReading{OriginClient,Store,TransferJobService,LifecycleTest}.kt.new-main-drift.diff`.
these changes remain excluded from native replay. reconstructed all ten earlier
approved files from a554 plus reviewed diffs; every full hash equals
`/tmp/native-reviewed-replay-source-list.json`. codec replay uses that exact set
at `d10e5e068f`, not current unknown main deltas.

units original canonical `a78356f4cd4de579` and spool-unlink auxiliary
`c09529dd5b4f3bcd` both pass. restored exact canonical row after the auxiliary.
setup-only `e342d11a4be2fe8a` lacked an offline locked package; dependency
hydration fixed it without source or lock changes. `8a53d974f851cb0a` rejected
a dirty preflight after the guarded copy aborted; no android execution occurred.

reviewed-snapshot execution: missing-kind canonical `30f5e1a7e298db6d`
and installed-access canonical `a858f54393a9dfff` both pass at `d10e5e068f`.
codec owner `b804e7ca...` observes the original Map.getValue fault as the named
wrong exception. access owner `5a828478...` asserts actual unreadable permission
stimulus, retained exact source/row, no Ready while unreadable, and successful
reopen after permission restoration. its original IOException-as-corruption
fault fails the named original-deletion assertion. newer main owners are not
attested by these receipts.

all 18 current-main deltas reviewed independently against `d10e5e068f`:
`/tmp/native-main-followup-deltas-20260914/inventory.json` retains full source
hashes and per-file diffs; bounded verdicts are
`/tmp/native-eighteen-delta-review-20260914.md`. no unknown source was removed.

- web capability (`76bc7954...`): reject both restored NoSuchElementException
  catches; codec normalization already owns malformed input, and unrelated
  missing invariants must remain defects.
- store (`402adc55...`), models (`ea1301f5...`), database (`48d44c25...`):
  reject the restored storage-refusal set and unsupported generic-exception
  inference of permanent source defects. durable conversion counts/status/skip
  policy are excessive without an explicit requirement. the new enum CHECK
  independently violates repository database ownership rules.
- origin (`c895c680...`), transfer (`3ba22fe8...`), lifecycle proof
  (`77e8e55b...`): capacity requeue may be coherent, but is new behavior. prove
  actual 503/status/Retry-After and durable staged/queued conservation through
  the existing HTTP/store/runner boundary; an enum assertion is insufficient.
  the full transfer may already have selected/staged bytes before this refusal.
- units (`15ab34a8...`): close the source cursor before other connections stage
  the database, using one-row keyset reads rather than an aggregate fragment
  list. source index is nonnegative and uniquely indexed. separate allocation
  ticket records the exact hazard.
- table index (`b6271a21...`): candidate-helper relocation is appropriate.
  verified-member resume is an optional optimization needing measured intact-
  source read savings; no new byte-identity objection found. empty directories
  are already ignored by source-file closure.
- geometry (`e891dd4a...`) is an exact source-to-test move; headers
  (`c6de613b...`) moves the identical algorithm plus the unchanged 46-line input
  stager from table index. query/workload unchanged; neither becomes activated.
- playback service (`b46457b7...`), artwork (`e751dd29...`), artwork proof
  (`87678db0...`): owned validated proxy routing is justified. remove dead
  nullable display attestation and prove ordinary upstream input through an
  actual owned HTTP request; existing cases cover preview sources only.
- installed fixture (`9c755685...`), database proof (`8c5879d1...`): new-column
  plumbing belongs only with the accepted policy. filtering new columns without
  asserting initial 0/null does not establish their migration behavior.
- store lifecycle (`dd0a4964...`): storage-status rewrite belongs to the rejected
  policy. deleting the original in the resume case is not intact-source
  reconciliation; use external read accounting for an efficiency claim. manually
  installed graph-invalid schema-two bytes establish byte/member acceptance,
  not actual ingress publication acceptance. preserve all original durable
  oracles.
- table preparation (`7de71cce...`): fail-fast external progress-origin factory
  is a useful independent strengthening; SQL placeholders depend on the new
  policy. keep their reviews and replays separate.

proposals remain outside checkout: native-derived one-row keyset candidate
`d77d5a47...` and `/tmp/native-artwork-owned-origin-draft/inventory.json`.
root owns unresolved author/policy disposition; no final pin refresh is earned
by this review alone.

provenance clarified by the user: Claude is actively reviewing/editing main;
preserve those incoming edits. the independent findings above concern semantics
and evidence, not authorization. later rationale appears in
`docs/modules/reader-implementation.md:1031-1036` and the recorded arbitration
in `bounded-workspace-publication-progress.md`: deterministic conversion refusal
should not repeat automatically. preventing repeated expensive work is justified;
the actual accepted max-atom refusal is a concrete example. this refines the
earlier blanket excess-state verdict. a converter-owned typed refusal, tied to
the exact immutable package and the converter version, can own that decision.
generic IllegalArgumentException/ClassCastException/NoSuchElementException cannot
establish it. arbitrary parser/SQLite/programming exceptions must not be labeled
Storage either. the failure counter has no current scheduling decision and is
diagnostic surplus; the existing exact-row readiness map remains the exposure
owner. unknown failures must preserve source/progress and remain observable.

all reviewed implementation belongs back on codex/bounded-workspace through
selective reconciliation. isolated receipts establish evidence, not a separate
deliverable or permission to overwrite incoming review changes.
