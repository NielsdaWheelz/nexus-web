# a downloaded episode's saved artwork never shows on android

problem: `DownloadedEpisode` reads the saved artwork through the device route, which demands the
`X-Nexus-Wire` header, so it fetches the bytes and shows them through `URL.createObjectURL`. the
app's csp allows `img-src 'self' data:` only, so the webview refuses every `blob:` image. the saved
picture has never displayed on android.

evidence: lab `20261102-104452-a11ba8647bbf`, emulator api 35, an episode downloaded through its
own menu with artwork `Ready` (41453 bytes, `image/png`) in `files/offline/state.json`. the webview
console: `Refused to load the image 'blob:https://127.0.0.1:31033/…' because it violates the
following Content Security Policy directive: "img-src 'self' data:".` code:
`apps/web/src/lib/security/csp.ts:15` (`APP` img-src; `PUBLIC_READER` at :31 already allows
`blob:`), consumed by `apps/web/vite.android.config.ts:15` for the packaged app;
`apps/android/app/src/main/java/app/nexus/android/AppRouter.kt:52-54` (wire header required, so a
plain `<img src="/_nexus/device/…">` answers 426);
`apps/web/src/app/(authenticated)/media/[id]/DownloadedEpisode.tsx:200-211` (blob url).

impact: at 53a428154 the image errors, is removed, and `saved artwork couldn’t open` waits behind
the pane's recovery control. since playback-bar lane 3 the 80px tile shows the show's initials,
silently, so nothing is wrong to look at, but the downloaded picture is still never seen.

resolved when: the owner of the csp admits saved artwork, most directly `blob:` in `APP` img-src
(it already admits `data:`, which a script can mint just as freely), and a lab case on the emulator
downloads an episode with real artwork and sees the image cover the initials in the 80px tile. lane
3's `identity-downloaded-android.spec.ts` gains that step.
