# android signing inputs disagree

on 2026-10-22 `deploy/env/env-android-release` selected certificate
`c196a8db…590a6`, while `~/.gradle/gradle.properties` selected the installed and
published app-link identity `40e566dc…8b17`. gradle user properties win, so the
0.3.5/code25 build from `99320b630` uses the correct signer and upgrades the
physical phone in place. a release machine without that override could build an
apk that cannot upgrade the installed app or verify its app links.

reconcile the private signing declaration with the existing release identity;
do not rotate the key or uninstall the app. resolved when explicit release
inputs and effective gradle configuration select the same existing signer and
an apk built from those inputs passes signature and in-place upgrade checks.
