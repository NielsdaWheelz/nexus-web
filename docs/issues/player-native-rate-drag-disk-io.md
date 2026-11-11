# native rate dragging performs synchronous disk writes

each applied rate on an active, unfenced episode persists the listening lane on
the service main thread. queued samples coalesce, but each applied command can
still synchronously write and sync files before acknowledgement. this is a
source-level responsiveness hazard; perceptible device stutter is unmeasured.

under `apps/android/app/src/main/java/app/nexus/android/playback/`,
`NexusPlaybackService.kt:80` uses the main dispatcher and `:536-537` calls
`recorder.pinRate` and `checkpoint`. `ListeningRecorder.kt:93-96,239-241`
reaches `PlaybackStore.update`; `PlaybackStore.kt:156-170` synchronously writes
and syncs the file and directory.

profile repeated rate adjustment during playback on the target device, measuring
main-thread disk work and command latency. repair persistence scheduling at its
existing owner if needed; retain ordered durability, final rate, offline recovery
and progress fences. resolve when that evidence establishes responsive controls
without repeated synchronous persistence blocking the playback control path.
