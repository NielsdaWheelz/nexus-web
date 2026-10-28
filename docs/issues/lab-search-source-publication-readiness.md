# retained search fixture cannot confirm source publication

on30ef, `20261027-172212-782ea3aed79d` stops in the outer setup of
`scope-activation.spec.ts:132–142`. the extracted canonical
`apps/web/scripts/lab/search.ts` python seed reaches `await_initial_text`, then
`await_current_text` at85–94 fails after45s: “source lexical revision, witness or
partition did not publish”. lexical/current revision, section bounds and witness
never jointly satisfy the existing predicate. no final sql-state snapshot was
retained, so delayed publication and a stale fixture prerequisite remain distinct
possibilities.

source review against search owner b34 finds the same predicate and publication
prerequisites; `prepare_media_parts` commits through `retry_serializable`.
`containers.log:74,79–136` shows the media-index background lane and sustained
note-index settlements, but no media-index settlement. dispatch delay or a media
lease refusal remains plausible; neither is proved. both enqueue paths use the
shared default priority. lexical/witness/bounds publish before embeddings, so
embeddings do not explain this missing proof.

the selected note-arrival case at262, its canonical note seed at150 and inspection
assertion at297 never execute. an isolated canonical note/passage control can
qualify the note ui, but does not qualify this media fixture or the retained three
search checks. keep their existing readiness oracle and deadlines.

owner: search publication and its canonical fixture. resolve by recording the
actual source/current-section proof and completing the unmodified publication
predicate through real owners, then qualifying the retained search entry. do not
force readiness, skip the predicate or substitute a larger wait. on the existing
45s failure, retain the preparation job id/revision, job status/error/availability/
attempts, and last index revision/lexical/witness/bounds plus observed section
keys. the seed now writes an owner-specific private diagnostic artifact on that
existing failure, using the actual preparation receipt and current owner/revision
jobs. diagnostic capture failures remain notes on the original assertion. the
45s loop and success predicate are unchanged. the three retained checks pass on
f73a4bf21 in `20261027-174235-aa5c53966f5e`, with canonical cleanup. the failure
capture branch was not triggered; the earlier incident's cause remains unknown.
obtain its job-state evidence before proposing a queue or publisher fix.
