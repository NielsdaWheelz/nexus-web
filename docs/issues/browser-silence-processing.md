# browser silence processing

saved preferences and paired persistence exist, but the browser has no silence
processor. `apps/web/src/lib/player/browserEngine.ts` explicitly refuses
`setShortenPauses(true)` through `PlaybackPreferenceError`; it cannot qualify
actual silence removal. the owner deferred processing to a separate follow-up
on 2026-10-21. this remains a combined-release dependency.

implement processing at the audio/media-delivery owners without a no-op or
device-policy fallback. qualify a known speech/silence source through production
delivery: less wall time at equal speed, intact speech, original-time position,
seek and chapters. expose failures through the current preference owner. the
android silence-skipping qualification waiver does not prove browser capability.
