# wake imports after unconfirmed source refresh

status: open; included in the feedback cutover
origin: 2026-10-16 feedback specification review; source at `69c00182c832`
area: media / source-refresh admission

problem: an accepted refresh with a lost response can leave an idle imports
observer asleep, concealing work that actually started.

evidence: `apps/web/src/lib/imports/api.ts:219-229` returns after publishing
unconfirmed feedback; imports invalidation runs only on acceptance at `:231`.
metadata admission already wakes observation in `finally`
(`apps/web/src/lib/media/mediaMetadataOperations.ts:175-177`). this is source
evidence, not a live reproduction.

prerequisites: retain the original refresh expectation and existing imports
observation policy. fix: wake imports after an attempted admission, including
an unknown outcome; do not wait for acknowledgement or add another poller.

acceptance: with imports idle, let refresh commit and drop its response.
imports observes the resulting work, while confirmation retains the original
expectation. observation alone does not discard unresolved recovery input.
