# slice 2 android share still accepts text only

origin: 2026-11-01 import survey at `61562d1`
status: carried open for slice 3 and its paired release

at `aed29154`, `apps/android/app/src/main/AndroidManifest.xml:65` advertises only `ACTION_SEND` with `text/plain`. `apps/android/app/src/main/java/app/nexus/android/ShareActivity.kt:57` reads only `EXTRA_TEXT` and exits when it is empty. file streams are not admitted by this slice.

impact: another app cannot share a pdf or epub through this entry contract. this is source evidence; no native journey was run for this disposition.

resolve with the slice 3 file-share contract and ordinary android pdf/epub `SEND` and `SEND_MULTIPLE` journeys, including real stream grants and imported results. preserve the separate pairing, lifecycle and installed-release limits; a source change alone does not close those observations.
