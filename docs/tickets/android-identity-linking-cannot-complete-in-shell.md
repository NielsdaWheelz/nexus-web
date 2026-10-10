# identity linking cannot complete inside the android shell

status: open · origin: 2026-10-10 auth reauthor (spec D1, coordinator review R4) ·
area: android / web auth. afaict from source; no handset run.

the identities pane's Connect link (`apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx`,
`/auth/oauth?mode=link&provider`) runs in the webview. `/auth/oauth` writes the
pkce verifier into the webview's jar and redirects to the provider, which is not
an owned url, so
`apps/android/app/src/main/java/app/nexus/android/MainActivity.kt:273-277` opens it
externally.
the provider returns to `/auth/callback` in that external browser, which holds
neither the verifier nor the session, so the exchange fails ("We couldn't
complete sign in."). the shell's `nexus://auth/start?mode=link` arm
(`MainActivity.kt:798-803`, `startAuthFlow`) exists, but web never emits `mode=link` (it keeps
emitting `mode=signin`, U3), and a custom tab has no session to link to anyway.

prerequisite: an owner call: carry the session into a custom tab (a handoff in
the other direction), or run the provider round trip inside the webview.

fix: one of those, end to end; web keeps accepting `mode` on `/auth/oauth`.

acceptance: on a handset, Connect GitHub from settings in the shell lists the
identity on return; the browser flow is unchanged.
