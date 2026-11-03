# native queue recovery uses a read-only label

at `dabdec901`, the native unanswered-queue hold says `check`, but its press
can pause playback and persist a checkpoint. feedback rule 9 and criterion 17
reserve `check` for reads.

`GlobalPlayerSurfaces.tsx:727` calls `commands.checkQueue`;
`lib/player/playerRuntime.tsx:1300` calls `readNativeQueue`, and
`lib/player/nativeEngine.ts:431` sends `queue_read` with `reconcile: true`
while unanswered work exists. android's `NexusPlaybackService.kt:770-772`
then retires activation, pauses and checkpoints. this is source evidence;
actual native unanswered-command ordering has not been induced.

label this existing recovery `retry`, preserving its callback and protocol.
resolved when the native held command uses that label and its contract states
the reconciliation effects; ordinary queue observation may still say `check`.
