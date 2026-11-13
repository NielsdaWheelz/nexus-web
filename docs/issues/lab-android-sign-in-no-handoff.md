# android lab sign-in stayed busy before browser handoff

run `20261112-182753-f9cb79757410` observed the enabled native sign-in control,
attached once through the canonical node 22.23.2 runner, and delivered a trusted
touch. the control remained busy; no handoff challenge appeared in native activity
state within the driver's 20-second observation. the owned app remained foreground.
the companion journey was not reached. the cause is unconfirmed.

evidence: private `artifacts/android-before-attach.xml`, `android-failure.png`,
`android-failure-native.json` and `android-results.json`; temporary driver
`android.ts:205`. the exact apk dex origin and observed page origin were both
`https://127.0.0.1:31003`, matching the owned reverse. cleanup reported no errors.

`MainActivity.kt:740` calls local `DeviceSession.newAttempt` before launching the
custom tab; no server new-attempt request exists. the retained diagnostics contain
the crash buffer, not full process logcat or java thread state. source inspection
alone cannot distinguish a pending credential operation from another local stall.

capture the exact owned process's full logcat and java thread dump before teardown,
and compare the packaged origin/ca with the current lab inputs. resolved when the
stalled owner is identified and repaired and the real password handoff completes.
do not widen the observation deadline or bypass authentication to claim success.

run `20261112-192443-257fcc546716` qualified the installed companion journey; this does not prove the earlier cause resolved.
