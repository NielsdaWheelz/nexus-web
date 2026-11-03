# an unavailable library read discards unanswered settings commands

problem: settings clears rename request and Rename/Delete uncertainty when its
read returns404. membership loss is masked as the same404, so this read has no
command-settlement authority. a previously dispatched rename can later restore
its request behind the unavailable early return, which renders no Hold. recovery
can disappear while an unconfirmed loss guard remains.

evidence at integration57f76e33:
- `apps/web/src/components/LibrarySettingsDialog.tsx:86,99,104-115,143,148-183`
  derives gone, clears both commands, hides recovery and restores late outcomes.
- `python/nexus/services/libraries.py:109-126` masks missing membership as404;
  rename263-289 commits through the serializable owner before acknowledgement.
  delete292-341 has its own idempotent acknowledgement; a read404 is not that204.
- `lib/actions/ResourceOverlays.tsx:60-63,85-90` mounts settings in a synthetic
  overlay visit. accepted guarded close abandons its cell; old setters cannot
  mutate a new entry. no new lifecycle owner is needed.

fix at the existing settings draft: preserve unresolved commands through read404,
render their existing recovery while unavailable, and retry frozen rename fields
or the absolute delete id without requiring current read data. retain accepted
acknowledgement, first-refusal and earlier-unknown distinctions. no protocol,
inventory or generic retry framework change.

resolved when delayed refused/unknown results after real membership404 preserve
reachable exact recovery, an actual acknowledgement settles it, and guarded
abandon/reopen isolates the old cell. prove both engines and independent review.
source audit confirmed; runtime qualification remains pending.
