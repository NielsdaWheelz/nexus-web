# android debug origin disagrees with the bff csrf origin

status: open (source fixed 2026-10-10 by the auth reauthor; emulator acceptance not
run) · origin: 2026-09-21 auth audit · area: local android / web origins

`apps/android/app/build.gradle.kts:11` defaults to `http://10.0.2.2:3000`. the
web app now has one origin per process, `APP_PUBLIC_URL` (`apps/web/src/lib/env.ts`,
default `http://localhost:3000`; `make web` passes
`APP_PUBLIC_URL=${APP_PUBLIC_URL:-http://localhost:$(WEB_PORT)}`): auth forms,
session resolve and the bff's csrf check (`lib/api/proxy.ts`) all compare
`Origin` with it, and the auth and device cookies are `Secure` only when it is
https (spec D8). the supported emulator story is therefore one setting:
`APP_PUBLIC_URL=http://10.0.2.2:3000 make web` with the debug app's default
`NEXUS_BASE_URL`; adb reverse to `127.0.0.1` with `APP_PUBLIC_URL` set to that
origin works the same way. browsing another host than `APP_PUBLIC_URL` cannot
sign in (it shows the wrong-address notice). `supabase/config.toml`
`additional_redirect_urls` keeps the per-run origins.

not run: no emulator or handset was available to the reauthor.

acceptance: with `APP_PUBLIC_URL=http://10.0.2.2:3000`, the default emulator
debug build signs in (the session cookie survives over http) and completes a
bff mutation; a run with the default `APP_PUBLIC_URL` refuses the emulator's
mutations.
