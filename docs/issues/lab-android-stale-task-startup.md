# repeated android lab install can race old task removal

problem: reinstalling and clearing the same disposable package can leave an old
android task's destroy timeout pending. launching the new process then races a
package kill from that old task; the lab cannot attach its webview.

evidence: `da19e2959`, lab `20261028-191625-da2108142934`, owned emulator 5640,
android 15, package `app.nexus.android.companionqa20261028`. activitymanager
started pid 5783 at 19:18:24.341, then killed it at 19:18:24.580 with
`remove task`; activitytaskmanager logged `Destroy timeout of remove-task,
attempt to kill Task ... #63`. no androidruntime fatal exception was logged.
`apps/web/scripts/lab/android.ts` installs, clears and launches the package;
its close stops it but leaves package/task state for a later invocation.

impact: repeated native qualification can fail before application observation.
the current caller uninstalls only its disposable package and waits for its
actual recent-activity records to disappear before installation. do not reset
unrelated packages or device state. resolved when repeated owned-package lab
lifecycles establish a stable new process without a stale task killing it.
