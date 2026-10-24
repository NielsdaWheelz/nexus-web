# native queue refresh can accept retired engine results

remaining gap: native read/page retirement and confirmed-null recovery are
implemented, but their fault-ordering cases lack actual-host qualification.

evidence at `2705809b1`: `apps/web/src/lib/player/playerRuntime.tsx:623-626`
passes only the result of `engine.queue.read()` to `nativeRefresh`. `:606-609`
reads the current engine ref and immediately publishes an empty ready queue for
a null header. `:610-619` protects nonnull paging with engine/revision checks,
but those cannot establish which engine originated the initial read.

the desktop player branch now retains originating engine/observation, matches
confirmed headers/null, and retires errors only after newer confirmed queue data.
the native adapter ignores timeout availability updates after a newer snapshot.
source review covers these invariants; it is not live race proof.

blocker: the actual api35 emulator's service shares the renderer's process
(`apps/android/app/src/main/AndroidManifest.xml`). `NexusPlaybackService.kt:794-810`
serves queue reads/pages locally. network delay cannot fail these operations;
process termination also destroys the renderer. forged bridge frames would not
qualify the real host. normal empty/read/page/restart journeys are separate.

resolve after real-host delayed read/page success and failure across engine
retirement cannot change current data/status, and a real failed first read can
recover to confirmed null. include a newer same-header successful page preceding
an older failure, and preparation/cancellation preceding a failed first read.
