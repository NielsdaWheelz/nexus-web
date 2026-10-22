# browser playback must preserve android silence defaults

the shared settings control now exposes the podcast silence preference, but the
browser engine has no silence processor. enabling it rejects explicitly; the
runtime keeps the requested choice visible and disables remember until actual
application succeeds. an inherited `Natural` choice fails the same way.

evidence: `apps/web/src/lib/player/browserEngine.ts`, `setShortenPauses`, rejects
on; `playerRuntime.tsx`, `syncPreferences`, retains inherited on as pending intent.
paired persistence and the checkbox do not supply processing.

the owner accepted android-only silence skipping on 2026-10-21. browser
processing is not a release dependency. browser speed controls and remembering
must work without applying unsupported silence processing or erasing the saved
android preference, including null. the separate silence implementation owns
this capability/persistence change. android device defaults remain removed.

resolved when inherited `Natural` does not block browser speed/remembering,
remembering preserves the original nullable silence preference, and the browser
truthfully explains its capability. qualify android processing independently;
see [release steps](release-playback-settings.md).
