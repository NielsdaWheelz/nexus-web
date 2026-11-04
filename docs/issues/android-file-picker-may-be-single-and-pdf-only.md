# android picker selection remains unqualified in slice 2

origin: 2026-11-01 import survey at `61562d1`
status: carried open; native qualification belongs to slice 3

at `aed29154`, `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt:97` returns `FileChooserParams.parseResult`, and `:284` launches `createIntent()`. the web import input requests multiple pdf/epub files (`apps/web/src/components/nexus/ImportPage.tsx:367`).

the historical claim that the platform returns only one pdf was an inference, not device evidence. this source review establishes the delegation, not the platform's actual mime or multi-selection result. slice 2 therefore does not close the risk that epub or additional selected files fail to arrive.

resolve with slice 3's ordinary android picker evidence: select pdf and epub, including multiple files, and join each selected file to its imported result. retain any source repair and its exact runtime limits. no new device check was run for this disposition.
