# android silence skipping uses an affected media3 processor

the android app pins media3 1.10.1. its silence processor computes the candidate
buffer without converting frames to bytes, so the nominal 100 ms minimum becomes
approximately 25 ms for stereo pcm16 (50 ms for mono). this makes skipping more
aggressive than its configured policy. clipped speech has not been observed on a
device in this investigation.

evidence at nexus `5ead65981`: `apps/android/app/build.gradle.kts:232` pins the
affected version; `apps/android/app/src/main/java/app/nexus/android/playback/NexusPlaybackService.kt:313`
enables the stock processor for `Natural`.
[the affected source](https://github.com/androidx/media/blob/1.10.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/SilenceSkippingAudioProcessor.java#L307)
omits `bytesPerFrame` from the buffer calculation.
[upstream pr 3271](https://github.com/androidx/media/pull/3271) explains the defect;
[media3 1.11.1 release notes](https://github.com/androidx/media/blob/1.11.1/RELEASENOTES.md)
record its fix.

resolved when the shipped processor includes the upstream correction and real mono/stereo
speech with short pauses is qualified on android at the supported playback
speeds. dependency/source inspection alone does not establish listening quality.
