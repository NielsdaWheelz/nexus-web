# deliver the selection annotation icon

the android interface is bundled in the apk. deploying the web popup change alone
does not deliver the mobile composer change to an installed build.

ship an apk containing the selection-dock icon and annotation focus-contract
changes with the web release. no wire, authored format, database migration or
data preflight changes are required. qualify touch activation, keyboard input,
explicit first save and bound-body readback on the supported android runtime.
native qualification currently encounters the existing
[webview attachment blocker](outline-android-touch-journey-unproven.md).

resolved when the release's web and installed android interface both expose the
saved-highlight annotation icon between highlight and chat, with no text opener,
and delayed focus respects later input.
