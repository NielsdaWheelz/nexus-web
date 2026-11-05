# article opening release qualification

status: implemented; coordinated production release remains outstanding.
contract: [source-backed pieces](../modules/reader-implementation.md#source-backed-pieces).

- use `deployment.md` unchanged: settle pending/failed/running jobs and open
  model calls through ordinary owners before stopped-writer cutover. preserve
  terminal discovery payloads/results; provenance is derived from the matching
  navigation proof, so no historical payload conversion or schema migration.
- regenerate wire types and pair clients under the once-per-release wire rule.
  advance the discovery prompt version; do not advance source publication or
  global section-detector versions merely to force refresh.
- audit current-generation candidates with `part_id IS NULL`, nonnull finding
  and title, including rejected rows. for selections resolving to their stored
  exact extent, accept literal selected-source titles, literal incipits inside
  the application's outer quotes, or matching `Publisher`/`Heading`/`Both`
  labels. a title supported only by an assembled `InferredNumberedEntry` label
  is the old provenance defect. audit independently of preparation and extraction
  readiness: pending preparation or absent rich cuts must not exclude a row.
  exclude only obsolete/mismatched section geometry. bound works remain outside
  this repair; record any confirmed historical title defect for owner review.
- if the audit confirms affected unbound proposals, record exact ids, versions
  and source generations. under the existing source/set locks, recheck those
  facts and refuse drift; clear only `finding`, increment each candidate version
  and its source part-set revision once. preserve ids, ranges, user decisions,
  accepted selections, bound works and all operation history. during the planned
  no-use window, after discovery has settled, perform this separate bounded
  maintenance transaction after a verified maintenance backup and before invoking
  the release controller. close its connection before release quiescence, then
  run the unchanged release workflow. no findings means no data repair; no corpus
  reset or recurring audit service.
- qualify all spec cases, including hosted/public/native shelf, rich extraction,
  title rejection and preserved progress. use existing preparation for changed
  geometry. sync/check device progress before removing an old reading copy to
  reacquire it; old copies remain valid and need no forced deletion.

resolved when the implementation, static gate, live cases, bounded candidate
audit/any required repair, and coordinated release have completed. proof belongs
in the pr; an unrun check is not a pass.
