# the android sharesheet promises an import for a shared quote

status: open · origin: 2026-11-02 import content sheet (slice 2), open point 8 · area: android / copy

the spec labels `ShareActivity`'s sharesheet target `Import to Nexus`. links and
prose both arrive as `text/plain` `EXTRA_TEXT`
(`apps/android/app/src/main/java/app/nexus/android/ShareActivity.kt:57-59`), under
one intent filter (`apps/android/app/src/main/AndroidManifest.xml:65-71`), so one
label carries both. plain text with no link lands in today as a note.

impact: sharing a quote promises an import and makes a note.

resolved when: the owner accepts `Import to Nexus` for both paths, or names a
label true for both.
