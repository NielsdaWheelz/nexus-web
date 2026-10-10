# browse preview audio on android was not exercised after the rewrite

status: open · origin: 2026-10-10 podcasts/browse web rewrite (design §12 A1) · area: browse / android player bridge

`PreviewAudioDescriptor` moved from `lib/browse/contract.ts` to
`lib/player/playerRuntime.tsx` and its `target` is now a plain string; the json
the web hands `window.nexusPlayback` (`title`, `source`, `imageUrl`,
`audioUrl`, `target`; `NexusPlaybackService.kt:297-307`) is unchanged by
construction. No handset lane was available, so no android webview Play
preview ran (desktop and phone-viewport journeys V1, V4 and M1 passed).

fix: none expected; run one preview-audio pass in the android shell.

acceptance: on a handset, an episode preview's Play preview plays through the
native player and Add stops it and transfers its position once.
