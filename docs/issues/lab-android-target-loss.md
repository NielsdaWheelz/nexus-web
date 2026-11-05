# owned android target closes during handoff

windowless api-34 qualification sometimes loses its webview cdp target before the
first library assertion. this blocks a complete native verdict on those runs.
the cause is unconfirmed; no application exception has been established.

evidence: runs `20261104-212921-a3387f4d584e` and
`20261104-214901-6c8f83389964`; the latter's private
`episode-native-scenario-error.txt:1` reports `page.goto: Target page, context or
browser has been closed`. adb reported offline during cleanup. emulator logs show
graphics initialization and shutdown, but do not establish a graphics crash.
the full journey passed in `20261104-220413-4bcaed454ae7` after explicit admission
and a retained-binding restart. earlier target loss remains unexplained.

reproduce the real native browser handoff on the owned windowless avd. account
binding precedes admission: await the public `session_check` ready result before
testing the app. capture emulator exit/signal, adb state, app pid, cdp targets and
guest crash logs BEFORE cleanup. repair the evidenced owner; do not guess graphics
flags or change global/device settings.

resolved when the handoff/target lifetime cause is understood and repaired and the
complete native catalog refusal/rebuild journey passes at the stated scope.
