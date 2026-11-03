# native account operations refuse an unadmitted session as a lapsed one

status: open · origin: feedback-homes f2 review, 2026-11-02 · area: android / settings

`DeviceSession.accountOperation` (apps/android/app/src/main/java/app/nexus/android/DeviceSession.kt:461)
refuses any session that is not remotely admitted with `NexusOriginError(401, "E_UNAUTHENTICATED")`,
whatever the admission is, `Unavailable` and `Checking` included. `AppBridge` replies 401, so
`lib/native/client.ts` publishes it through `observeRemoteFailure(401)` (admission flips to
`Checking` and rechecks), and the settings pane's `fail` reads `transportOf` as `SignIn`.

impact: on an installed client that is offline, changing the email or unlinking an identity says
`couldn’t update your email. sign in to continue.` with a sign-in verb. that is false: the session
is fine and nothing left the device. the write partition is right (a 4xx is refused, nothing ran);
only the reason is wrong.

evidence: by reading; not reproduced. `NexusOriginClient.execute` (NexusOriginClient.kt:331-336)
already maps an unadmitted session by its admission: `SignInRequired` to 401, `UpdateRequired` to
426, anything else to an unsent `NexusNetworkError`. `accountOperation` passes `current`, so it
skips that check and makes its own.

fix: refuse in `accountOperation` by admission, as `execute` does, with a code that only an unsent
refusal carries, and map that code to `sent: false` in `lib/native/client.ts` beside
`E_REMOTE_UNAVAILABLE`. needs the next native release.

acceptance: on an installed client in airplane mode, an email change says `you’re offline.`,
offers no `sign in`, and leaves admission `Unavailable`.
