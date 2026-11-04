# native authored throws are classed by their message

status: open
origin: 2026-11-01 feedback-homes L0a review
area: android / authored sync

`AuthoredBridge.kt` answers status 500 and code `E_AUTHORED` for every throw that is neither
`NexusOriginError` nor `NexusNetworkError`. `native.ts` is left with the message: one that
starts `origin ` keeps its status, and any other loses it, which `sync.ts` reads as a broken
local invariant, `Refused`.

the prefix errs both ways. three remote throws miss it and read `Refused` though the next
attempt can differ: `retired credential operation`, `WebView rejected owned-origin cookie`,
`WebView cookie acknowledgement could not be scheduled`. four more pass it and read
`Retrying` though they are not `NexusOriginError`: `origin answered without data`, `origin
answered a malformed body`, `origin answered without content`, `origin content length
mismatch`.

impact: a credential race raises one `notes can't sync` slip, which a later turn retracts.
main read the same throws as `sync_error`. rare.

evidence, by reading, android unrun:
`apps/android/app/src/main/java/app/nexus/android/authored/AuthoredBridge.kt:242`;
`apps/android/app/src/main/java/app/nexus/android/NexusOriginClient.kt:66,77,84,297,316,384,391,404`;
`apps/web/src/lib/authored/native.ts:37-40`.

blocked on: the next native change. the feedback-homes spec makes none.

resolved when: the bridge sends a field that separates a local invariant from a remote
failure, and `native.ts` reads that instead of the message.
