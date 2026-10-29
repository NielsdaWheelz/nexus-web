# mobile pane opening android qualification

installed android acceptance remains pending. the task has an isolated api 34
avd and the configured google client id, but the real custom-tab sign-in browser
must trust the lab certificate authority independently of the app's debug trust.

evidence: `apps/android/app/build.gradle.kts` owns app-scoped debug ca packaging;
`docs/local-rules/testing-standards.md` requires real installed sign-in and forbids
device-wide settings changes. `docs/mobile-pane-opening-spec.md` retains that
restriction. on 2026-10-28 the owner approved certificate installation only on
the task-owned disposable emulator, removed after qualification. no personal
device or host trust change is authorized. real sign-in uses the disposable lab
password account, not the owner's google account.

resolved by real custom-tab sign-in and the spec's installed keyboard, back,
touch and persisted-pane journeys on the final source, followed by owned cleanup.
browser evidence alone does not resolve this issue.
