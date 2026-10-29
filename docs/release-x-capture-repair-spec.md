# x capture repair and migration readiness

investigated specification draft, 2026-10-28; pr 1 of the release repair scope.
published for review at the owner's request. specification only; no production repair, data
disposition or deployment is authorized by this document. lasting contracts
belong in module docs; implementation proof belongs in the pr.

## outcome and known evidence

make the actual production corpus convertible without inventing provenance or
losing writing. the release survey observed production `3d81ef45`, schema 0317,
wire 16; reviewed main `3b32fcc4e` targeted schema 0328, wire 17, authored format 4.
main is now `96a3b7bdf` after outline pr 862; recheck the final release identity.

the untouched `nightly/2026-10-28/database.dump` restored and passed 0322, then
0324 refused source `01a1627e-bfd1-79d8-a3ea-a04c827487df`. a bounded read-only
production census on 2026-10-29 utc resolves the ambiguous error: 97 of 108
sources have unknown capture time, but every affected source has exactly one
index-zero fragment and retained provider payload. all 97 also have null
`checked_at` and `logical_post_id`. no source body is missing in this census.

this is a historically valid representation. migration 0293 at `690744421`
explicitly constructs posts with both observation times null
(`0293_x_thread_sources.py:1878-1885`). retained production verification of
0292-to-0306 at `99320b630` records 97 canonical posts; every affected current
media id is in its reader map. `0324` introduces a stronger date requirement
that the known corpus cannot meet honestly. the first refused uuid does not
identify a unique corrupt record.

affected relations include six highlights, one attached annotation note,
57 thread memberships, 68 incoming embeds, 42 library entries, 186 incident
resource edges, four retrievals and one reader-state row. counts overlap and
exclude json-embedded destination inspection. exact census/hashes are retained
privately; no private text
or provider payload is copied into this plan.

full 0317-to-current-head qualification remains blocked. no restore or conversion
was performed in this investigation. earlier 0317-to-0320 and representative
annotation conversions do not establish the complete upgrade.

## owners, scope and invariants

- historical source ownership: retained provider payload, acquisition attempts,
  fragments and observation times; conversion:
  [0324](../migrations/alembic/versions/0324_x_capture.py).
- the historical conversion and existing nulls are evidence, not corruption to
  repair. complete the dependent-reference census on the restored corpus; do not
  rewrite production dates merely to satisfy the new constraint.
- preserve original text, identities, exact accepted commands, causal prefixes,
  quotations, grants and recoverable destinations. unknown provenance stays
  unknown; a fresh fetch or post publication date is not an original capture.
- correct the unshipped frozen converter and canonical type. a migration after
  head cannot cure a refusal at 0324. missing bodies, ambiguous identities and
  malformed evidence must still refuse; date absence alone must not.

## proposed contract and implementation boundary

1. `x_post_captures.captured_at` means the time of the original body observation,
   nullable when that time was not retained. make the unshipped 0324 ddl and
   `XPostCapture` mapping express that canonical fact. preserve the original
   null and fragment identity during conversion. leave `created_at` as row
   creation time; it must not masquerade as historical observation time.
2. retain required times for new acquisition: `XAcquiredSource.validate_capture`
   already rejects new posts without capture/check timestamps, and normal
   capture publication accepts a concrete datetime. new article excerpts and
   asset archives keep their genuine observation/archive times. do not weaken
   ingress validation merely because persisted historical data may be unknown.
3. preserve `XSourcePost.body_captured_at`, `ReaderXPostOut.body_captured_at`
   and public-share propagation as nullable. these contracts already admit null.
   `ReaderXCaptureOut.saved_at` currently requires a datetime and the standalone
   reader derives it from capture time; make that summary field nullable too.
   omit the date phrase when unknown, retaining the post count. thread summary
   dates retain their existing actual publication time. use no fabricated fallback.
4. regenerate paired wire/client assets. the wire change rides unreleased 17;
   no extra authored-format bump is indicated by this timestamp change alone.
   downloaded readers consume the same reader schema and must be qualified.

## historical highlight provenance

2026-10-29 contract refinement: the date correction exposes a second 0324
refusal. 0320 deliberately seeds all six historical x highlights with unknown
original publication. five now point at a generation-four reader. retained
historical anchor-move records establish their current association, but do not
prove the full source body observed at original creation. neither generation one
nor a matching current quote should manufacture that missing provenance.

for highlight selections, the existing `publication: null` means the original
publication is unknown. an `x_capture_offsets` locator may independently name a
proved retained destination. 0324 must preserve all six nulls while requiring
the exact media/fragment mapping, bounded offsets, literal quotation and matching
relational anchor. explicit publications must still match the recorded reader
generation before conversion. passage conversion and its refusals stay unchanged:
passages lack the highlight's retained locator projection; this corpus has no
authored x passages. source stubs describe retained sources, not observation history.

the shared selection validator, server upload validation and excerpt query must
admit that canonical highlight state without weakening capture admission,
capture/fragment identity, offsets or quote validation. source navigation and
chat selection derive their destination from the validated locator. saved literal
excerpts remain available; unknown original full-source extent stays unknown.
0326's historical `source_extent: null` is not reconstructed from today's body.

new highlight creation and explicit reselection must require a known matching x
publication at the shared command owner. ordinary body/color edits, restore,
move/unlink and synchronization preserve existing unknown provenance. introduce
no historical-id allowlist, compatibility reader or new provenance structure.
regenerate the current semantic helper and paired clients. change frozen migration
helpers only if their actual entrypoints require it; qualify the complete chain.
this correction rides unreleased wire 17 and authored format 4.

prove all six nulls, identities, quotes, offsets, stamps/vectors and annotation
writing survive. exercise snapshot/bootstrap, excerpt display, source navigation,
paint, chat selection, downloaded reading and upload after ordinary edits. verify
new creation/reselection rejects unknown x publication, explicit mismatches and
invalid anchors still refuse, and nonempty accepted source prefixes remain intact.
the cost is admitting a broader truthful stored state and using locator identity
at its consumers; the original full-source view remains unavailable.

## other consumer findings

source tracing found no captured-time ordering dependency in the x capture
selection path: capture reuse orders by id and compares payload, contexts and
fragment, not timestamps. a later identical acquisition may reuse an undated
capture; it must not retroactively overwrite that capture's original unknown
time. alias check time remains a separate current observation.

independent review flagged `x_ingest.py:522`, which publishes acquired captures
with `item.source.body_captured_at or datetime.now(UTC)`. trace its validated
acquisition boundary during implementation and remove an unjustified fallback
if present; it must never become a path that fills historical nulls with today's
date. new ingress validity and historical absence are separate facts.

search uses fragment/capture identity and payload. the reviewed authored and
0326/0327 conversion paths do not reference this timestamp. these are source
observations, not proof that migration, indexing, snapshots or all clients pass.

## remaining uncertainty and decisive experiment

the strongest objection is that some consumer may require a nonnull capture date
for identity, presentation or chronology. the traced required consumer is the
reader summary, whose unknown value has a truthful presentation. implementation
must complete the global consumer inventory rather than invent a date to satisfy
a decoder. this is one canonical nullable fact, not an old-format reader arm.

the smallest decisive experiment is an isolated restored production archive with
the proposed conversion/type correction, followed by the normal complete upgrade.
first prove all 97 known unknowns survive and all 11 known capture times remain
unchanged; then exercise one migrated standalone post, one thread/context view,
one highlight/annotation and a genuinely new acquisition through actual owners.
compare new observation versus deduplicated old-capture behavior explicitly.

further refusals may emerge after this first blocking predicate. inspect and
classify them individually; a successful date conversion is not full-corpus
acceptance. a genuinely unprovable body or mapping still requires an explicit
repair/disposition. no current evidence requires a live timestamp repair.

## acceptance, costs and dependencies

compare rich writing/yjs identity, captures, references/order, grants, accepted
bytes/prefixes, ranking fields and unaffected publications before/after. account
explicitly for intentional conversions, including consumed annotation notes;
unchanged row counts are not the oracle. verify format-4 snapshots, old-producer
and below-floor refusal, and post-conversion move/unlink/restore uploads. an
unsupported conversion must leave the prior schema and corpus unchanged.

costs: nullable summary dates and absent date copy for these historical captures,
paired client delivery, coordinated downtime and device reprovisioning. no data
deletion or timestamp invention is part of this repair. external consumed-note
urls still have no redirect under the separate annotation cutover. preserve
pending device writing and downloads. final proof uses the frozen integrated
candidate, canonical lab/recovery path and
[verification rules](local-rules/testing-standards.md).

issue owners: [x cutover](issues/release-x-captures.md),
[annotation cutover](issues/release-highlight-annotations.md).
release execution remains in [deployment.md](../deployment.md).
