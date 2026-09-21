# android debug origin disagrees with the bff csrf origin

status: open · origin: 2026-09-21 auth audit · area: local android / web origins

`apps/android/app/build.gradle.kts:11` defaults to `http://10.0.2.2:3000`.
`.env.example:64-68` allows that auth callback but leaves `APP_PUBLIC_URL`
commented out. `apps/web/src/lib/env.ts:resolveAppPublicOrigin` then chooses
`http://localhost:3000`; `lib/api/proxy.ts:149-153` rejects mutating requests
whose origin differs. source therefore predicts 403 for default emulator
mutations even though auth accepts the emulator origin. no device run verified
this consequence; configuring the public origin is a known workaround.

fix: establish one explicit supported local-origin configuration and align
android, auth and csrf with it. distinguish callback redirect allowlists from
mutation authority; do not broaden production csrf acceptance blindly.

acceptance: the documented default emulator setup signs in and completes a
bff mutation; unrelated origins still fail. test deployed proxy-origin
handling separately if that policy changes.
