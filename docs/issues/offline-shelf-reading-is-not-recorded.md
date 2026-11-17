# reading in the offline shelf is not recorded

status: open · found 2026-11-16 by reading at `fcd6843db`; not run · area: android / consumption activity

problem: the downloaded reader (`apps/web/src/shelf/ShelfReader.tsx`, mounted by the
android shell's shelf) renders `DocumentReaderView` with no consumption capture; nothing in
the file starts or delivers activity spans. the shell records listening natively
(`apps/android/app/src/main/java/app/nexus/android/playback/ListeningRecorder.kt`), not
reading.

impact: a day read offline on the phone records nothing, so stats, streaks and any run or
award undercount the reader who reads most away from a connection.

prerequisite: decide whether shelf reading should be observed and delivered later through
a durable outbox, as android listening already is.

resolved when: twenty minutes read in the offline shelf appear in stats for that day once
the device reconnects, or the owner records that offline reading is not observed.
