# stopping uncertain delivery silently resumes its surviving suffix

at `5eca855d4`, `apps/web/src/lib/notes/journal.ts` `retireWriting` deletes the
selected intent and transitive dependents only. later unrelated queued writing
then resumes without a new reviewed decision. the temporary decisions case
incorrectly expects that replay.

the spec requires no surviving-suffix replay after explicitly retiring an
uncertain head. preserve every later authored draft and stop that pending suffix;
known no-effect refusals retain the narrower dependency rule. make the affected
scope explicit in the confirmation. resolved when a real commit/dropped-reply
journey retains dependent and unrelated suffix prose, sends neither silently,
and permits a genuinely new decision after review.
