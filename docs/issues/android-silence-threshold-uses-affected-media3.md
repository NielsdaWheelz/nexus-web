# corrected android silence processing still needs device qualification

the previous media3 1.10.1 silence processor computes the candidate
buffer without converting frames to bytes, so the nominal 100 ms minimum becomes
approximately 25 ms for stereo pcm16 (50 ms for mono). this makes skipping more
aggressive than its configured policy. clipped speech has not been observed on a
device in this investigation. the branch now pins corrected media3 1.11.1 and
kotlin 2.3.10; a successful build does not establish native or acoustic acceptance.

evidence at nexus `5ead65981`: `apps/android/app/build.gradle.kts:232` pins the
affected version; `apps/android/app/src/main/java/app/nexus/android/playback/NexusPlaybackService.kt:313`
enables the stock processor for `Natural`.
[the affected source](https://github.com/androidx/media/blob/1.10.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/SilenceSkippingAudioProcessor.java#L307)
omits `bytesPerFrame` from the buffer calculation.
[upstream pr 3271](https://github.com/androidx/media/pull/3271) explains the defect;
[media3 1.11.1 release notes](https://github.com/androidx/media/blob/1.11.1/RELEASENOTES.md)
record its fix.

current blocker: at `ee12cd4e4`, the debug apk builds, but the native driver stops
before installation with `error: device 'RFCT51J2MCH' not found` from
`adb -s RFCT51J2MCH reverse --list`. only the unrelated emulator is visible.
the owner must reconnect the physical phone; no device lifecycle workaround is
authorized. the corrected processor, native lifecycle and recordings remain
unqualified. bluetooth is explicitly waived.

resolved when the same mono/stereo short-gap inputs preserve their intervals,
long gaps shorten, native streaming/download/background/lock-screen/source-clock
behavior and actual native controls/positive estimate rendering pass, and the
owner auditions actual off/on speech recordings at 1×, 1.5× and
3× for additional consonant loss, clicks, imbalance and cadence. retain the
temporary cases until that qualification; timing cannot establish listening quality.
