# does android back reach the outline's escape handlers?

status: unproven verification concern, not a demonstrated defect.

the android shell delivers back as a synthetic `Escape` keydown dispatched on
`document` (`apps/android/app/src/main/java/app/nexus/android/MainActivity.kt`,
`handleOnBackPressed`) and navigates only if nothing prevents it. the outline's
selection handlers listen on the editor's dom (`outlineController.ts` head and
block keys, `NoteEditor.tsx` key routing), so an event whose target is `document`
should never reach them; `LocalOutline.tsx`'s document-level intent listener
checks `isTrusted`, and nothing in `apps/web/src` re-dispatches a `KeyboardEvent`.
one document listener does receive it: while a bullet drag is live,
`OutlineDrag.tsx` listens for keydown in document capture and consumes escape to
cancel the drag, so back during a drag cancels it and does not navigate. that is
the intended reading; it is equally unobserved on a device.

source reading therefore says back with a caret or a selection navigates once and
leaves the selection unchanged. no case has run it: the emulator journey that
would prove it is blocked before this step
([outline-android-touch-journey-unproven](outline-android-touch-journey-unproven.md)).

resolved when, on the owned api 34 emulator, back with a caret in a nested note
navigates once with the selection unchanged, and back during a touch drag cancels
it with no write and no navigation. if either fails, fix the responsible listener;
no `isTrusted` guard is added speculatively.
