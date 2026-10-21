# browser silence processing remains absent

the shared settings control now exposes the podcast silence preference, but the
browser engine has no silence processor. enabling it rejects explicitly; the
runtime keeps the requested choice visible and disables remember until actual
application succeeds. an inherited `Natural` choice fails the same way.

evidence: `apps/web/src/lib/player/browserEngine.ts`, `setShortenPauses`, rejects
on; `playerRuntime.tsx`, `syncPreferences`, retains inherited on as pending intent.
paired persistence and the checkbox do not supply processing.

the owner deferred browser processing as a separate release dependency on
2026-10-21 and waived android silence-skipping qualification for this task. unset podcast silence means off; android device defaults are removed. keep
application acknowledgements truthful and preserve original media time for
seeking, chapters, transcripts and listening writes.

resolved when real speech/silence audio completes faster with skipping enabled
at equal speed, speech stays intact, seeking/chapters use original time, and the
shared control applies/remembers the pair on browser and android. qualify the
processing independently; see [release steps](release-playback-settings.md).
