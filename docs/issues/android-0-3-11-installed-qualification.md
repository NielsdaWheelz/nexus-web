# qualify the signed android 0.3.11 on the handset

status: `NOT_RUN`. on 2026-11-05 the owner waived physical installed qualification
for source `191ae44612d22626251a0d17950d3077d89650da`, android `0.3.11` / code `32`,
wire `19`. package and signature verification passed; this candidate has not been
installed or exercised on the physical phone.

the published artifact is
[nexus-android-0.3.11.apk](https://github.com/NielsdaWheelz/nexus-web/releases/download/android-v0.3.11/nexus-android-0.3.11.apk),
under `android-v0.3.11`. its sha256 is
`4d7cbeb2638bc9a25687e78f0a5a7d20ae9d25b6bed2eb991f22db95eb7cdfb6`;
the existing `app.nexus.android` signer remains
`40e566dc0cde3b63ea8bf8f0779802938c0ba19d5c32d4810f28fdc546fd8b17`.

resolve by upgrading the existing handset with this signed artifact without
clearing storage, then observing startup, retained login, app links, a normal
share/import, reading, an authored sync and offline shelf-to-online reconnect
against the paired wire-19 server. retain the
separate [installed offline journeys](offline-installed-release-qualification.md)
and [offline restart gap](android-offline-restart-qualification.md).
