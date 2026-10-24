# online-first writing cutover

the online-first writer removes browser writing persistence. the owner explicitly
authorized discarding all old local writing on 2026-10-23, including
unsent text and pending/uncertain requests. do not add review/export, a converter,
legacy reader, fallback or permanent cleanup path. release execution must follow
the exact account/origin inventory below.

release prerequisites and owner steps:

1. identify the exact authenticated account(s), hosted origin/browser profile(s)
   and installed webview(s). inventory exact indexeddb database names only;
   the removed writer used `nexus-writing:<account_id>` (`bdae1bb52`,
   `apps/web/src/lib/notes/journal.ts:804-817`).
2. quiesce active playback/download work through ordinary controls, retaining its
   saved state. close every old writing client and stop its delivery. deploy the new hosted
   writer; use a same-origin document without application scripts for exact
   browser deletion. installed android uses the temporary maintenance procedure
   below, then the final app. remove surviving matching session-storage branch
   pointers, never the entire store. blocked deletion is unfinished cleanup.
3. apply the existing paired release procedure. backend wire/schema remain
   unchanged unless actual separately reviewed changes require otherwise. the
   writing export bridge is same-release and unversioned; ship paired web/apk
   without its four export operations. never reopen an old writing client.
4. verify no writing database is read, recreated or populated. server-acknowledged
   writing survives; discarded local input does not. deleting an uncertain local
   request cannot undo work already accepted by the server.
5. qualify exact-build desktop/android writing, passage save/send, exit/signout,
   share capture and retained offline data. keep static, real-stack, installed,
   live-provider and deployed results distinct in the release pr.

## temporary android maintenance

the owner selected this procedure on 2026-10-23. the release webview disables
debugging and `.debug` uses another app namespace; neither an inspection command
nor a debug-apk result proves this cleanup.

- build one temporary apk with the actual installed application id, signing key
  and existing webview data directory. version codes must satisfy
  `installed < maintenance < final`; upgrade without uninstalling or clearing data.
- its launcher opens only a local maintenance document at the exact former
  writing origin; it never starts normal app/auth/writer flows or loads old web
  bundles. its manifest exposes only the isolated maintenance activity: no normal
  share/deep-link activities, job/playback services or other startup entrypoints.
  use `loadDataWithBaseURL` with that explicit https origin, javascript
  and dom storage enabled, no network subresources or navigation. this is the
  proposed mechanism, to qualify against the installed namespace before release;
  [android documents how the base url sets the origin](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content#loaddatawithbaseurl).
- inventory and deletion may be two phases of the SAME temporary apk; freeze
  and display the exact operator-entered allowlist before enabling deletion. no
  default selection or second maintenance upgrade is required. freeze the exact
  account/origin/database allowlist before execution. call
  `indexedDB.deleteDatabase` for each named `nexus-writing:<account_id>` database;
  never decode, export or replay its contents. await success and verify absence;
  error, blocked deletion or incomplete inspection fails the step visibly.
- no `WebStorage.deleteAllData`, native signout, app-data reset, cookie clearing,
  download/catalog/playback purge or database-name prefix deletion. preserve all
  unrelated state. record a terse completion result containing names/outcomes,
  never authored text or credentials.
- qualify old release -> maintenance -> final in the same installed namespace,
  with writing entries and unrelated offline state present. prove exact removal,
  no writer startup and unchanged unrelated data. the actual device cutover still
  needs its own result; a `.debug` installation proves none of this.
- remove the temporary source patch, asset, manifest changes and build switches;
  build and verify the clean final paired apk, then install it. no maintenance
  route, legacy database reader, debug mode or cleanup feature ships in that app.

temporary maintenance code is release tooling, owned by package e with platform
review; it never lands in the final product. actual-phone qualification remains
tracked in [android-writing-store-purge-unqualified](android-writing-store-purge-unqualified.md).

this owner disposition supersedes journal-preservation/export requirements for
this cutover in `release-writing.md` and `release-offline-startup.md`. it does not
waive unrelated live saving, account, receive or playback qualification.

resolved after implementation, exact-store removal, paired deployment and the
named acceptance checks are recorded. local source/static/browser qualification
is separate from release execution. actual account/origin inventory, paired
deployment, actual browser/phone purge and post-deployment journeys remain
`NOT_RUN`; no phone data has been changed.
