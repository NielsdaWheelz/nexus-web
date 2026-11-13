# librarian omitted from browser offline navigation

`apps/web/vite.android.config.ts:114` generates the browser service worker's
navigation allowlist with the retired `/conversations` route and omits
`/librarian`. an offline full navigation or reload at `/librarian` therefore
bypasses the cached installed shell. the android `AppRouter.isAppRoute`
(`apps/android/app/src/main/java/app/nexus/android/AppRouter.kt:37`) has its own
admission and is unaffected by this allowlist.

observed in source at `87e83a8ac`; the offline browser journey has not been run.
replace the retired route with the librarian's canonical route and qualify a
fresh browser shell installation, offline librarian reload and reconnect.
resolve when `/librarian` receives the cached shell offline and `/conversations`
no longer has a separate cached entry path.
