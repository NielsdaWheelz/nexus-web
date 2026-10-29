# release x quote captures

status: implementation and disposable migration/live qualification complete;
production census, device synchronization, backup and coordinated release outstanding

the [capture ownership contract](../modules/ingest.md),
[retention contract](../modules/storage.md) and
[sharing contract](../modules/resource-sharing.md) change x source ownership,
authored references, reader locations and client format together. mixed versions
cannot read/write safely. owner approved synchronizing every device before release
and retaining committed captures/images indefinitely.

the cutover rides the existing pending wire 17, the first break after shipped
wire 16 (`3d81ef45e`), under the once-between-releases rule. do not increment it
again unless a subsequent release has shipped. regenerate paired wire types.

release conditions:

1. census source bodies, context edges, explicit holdings, authored source bindings,
   source snapshots, persisted reader/workspace destinations and current replicas.
   ambiguous/missing original capture mappings need explicit live repair; never
   relabel a later fetch as the original or silently discard an annotation.
2. qualify the single migration against a disposable restored database. preserve
   highlight/link/passage ids, causal frontiers and note/page yjs bytes; compare
   converted snapshots and fragment ownership. remove the paired-null highlight
   anchor check without adding a general fragment fk. convert exact chat evidence
   and persisted source destinations too; reject semantic-key collisions.
   record proof in the pr.
3. commit every editor buffer and sync every browser/android device. verify empty
   outboxes, accepted source prefixes and the common account head. unknown or
   unavailable devices block cutover. freeze writers and take a verified backup.
4. deploy the single schema migration, converted authored snapshot/feed floor,
   wire/format revisions, api/workers, web, extension and android together. reject
   old producers before replay comparison and below-floor feeds before decoding.
   retain old accepted prefixes/bytes. the combined excerpt migration 0326 moves
   authored writing to format 4 and requires that format in every upload envelope.
   this explicit producer fence supersedes the earlier fresh-replica transition:
   existing device identities/counters survive, and the reserved server:2 producer
   continues its sequence. stores rebootstrap only after local empty-outbox proof,
   preserving existing snapshot-completion checks. follow the paired
   [excerpt cutover](release-highlight-excerpts.md).
5. qualify source reading through a retained highlight with no media, quote
   import/removal, thread reading, images, sharing and one local authored sync.
   the reported item is `01a1627e-bd78-78fa-bb89-fd76a1a0886a`; its context-only
   media must retire without losing its parent's captured quote.

rollback requires stopped writers and matched database/client restoration; an
old binary cannot run against the new schema. capture reclamation and video
archival remain outside this release. delete this issue when the release is
qualified and its operational conditions no longer need owner action.
