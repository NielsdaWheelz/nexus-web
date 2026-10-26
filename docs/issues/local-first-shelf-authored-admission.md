# downloaded reader authored access needs entry scoped admission

target gap: offline annotations need the native authored store from the packaged
shelf. granting the whole shelf origin that capability would broaden access
beyond its trusted entry document.

evidence: `apps/android/app/src/main/java/app/nexus/android/offline/ShelfRouter.kt`
serves downloaded assets under `/shelf/copies/`; `MainActivity.kt:169` admits
shelf-host mainframes. `webkit/OwnedOriginWebMessage.kt` checks origin/mainframe,
which alone does not identify `/shelf/index.html`. the shelf's network isolation
also means its javascript cannot use ordinary remote fetch for synchronization.

resolved when the authored bridge admits only the packaged entry's current
document generation, source assets cannot become privileged mainframes, and
fixed native sync calls preserve the shelf's network isolation. verify offline
annotation/reopen/sync in downloaded pdf and text readers, plus denied source
document/subframe access. reuse existing bridge framing and account authority;
do not broaden account/settings operations or add arbitrary network/file access.

native18, source `597473844`, run `20261025-170237-0031d206e243`, proves the
installed saved-pdf capture, cold reopen, attached-note edit, automatic upload
after server recovery, and denied source mainframe/subframe access. saved-text
qualification remains in the mixed-device case; keep this issue until that passes.
