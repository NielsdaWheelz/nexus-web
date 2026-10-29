# deliver quiet feedback to installed clients

the shared feedback and authored-read adapters also ship in the android interface,
downloaded reader and share capture. deploying hosted web alone does not update
those packaged surfaces. no database, backend wire or native persistence change
is required.

owners: `apps/web/package.json` (`build:packaged`, `build:extension`) and
`apps/android/app/build.gradle.kts` (`buildPackagedUi`). rebuild the applicable
client artifacts from the release source and complete the ordinary paired-client
release steps. this implementation does not deploy or replace installed clients.

the browser worker now preserves modeled local-storage error codes. qualify the
updated worker together with the updated interface; an already running shared
worker can retain old code across tab navigation. drain uncommitted writing and
restart the browser session during this hard cutover. change no stored format or
backend wire revision solely for this presentation/error-classification change.

resolved when the released hosted and rebuilt packaged clients use the same
quiet-feedback contract, with real webview/keyboard, shelf and capture recovery
checked on those artifacts. implementation qualification remains separate from
production delivery.
