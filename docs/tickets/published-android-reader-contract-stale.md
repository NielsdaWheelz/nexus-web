# published android apk uses an obsolete reader contract

status: open
origin: 2026-09-22, connected-device account/download lockout investigation
area: android release

`gh release view` identifies `android-v0.2.14` (2026-09-08, version code 17)
as latest. its `OfflineReadingModels.kt:11–12` declares reader contract and
bundle 1. production `/version` reports source
`a4cb9cf51027cb2f3e869bd15ff0103476398c30`, whose
`python/nexus/schemas/offline_reading_package.py:26–27` requires both 2.
the connected sm-s906w installed this apk on 2026-09-22 and displayed
“Nexus could not confirm this account for downloads.”

the old apk rejects the server version and blocks the online workspace.
its downloaded shelf is empty; reconnect also encountered a local “Not found”
response. this session repairs native recovery and prepares a compatible apk,
but a local installation does not repair the published download.

prerequisite: review and commit the native fixes, build and verify the signed
apk with the existing signing identity. publish that exact artifact, checksum,
and manifest as the next stable android release. the release operator's
compatibility step is now explicit in `README.md`.

acceptance: github's latest stable apk supports production reader contract 2;
installing it over 0.2.14 preserves the session, opens the workspace, and
returns from downloaded reading to hosted nexus. delete this ticket after
publication and record the artifact digest in the release.

local repair verified: signed `0.2.15` / code 18 installed over the existing
app without clearing data. login, the existing book at 51/149, and verified
app links survived. a deliberately incompatible probe verified the update
dialog, continue-online action, shelf reconnect, and an owned link from the
shelf. `./scripts/test` and release assembly including lint vital passed.
final apk: `apps/android/app/build/outputs/apk/release/app-release.apk`;
sha256 `0faadfbb3815eb8672cc50a0cd70b1f7b04e8a5760ea8cc7fff90e2eab86a8f5`.
