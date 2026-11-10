# outline android touch journey is unproven

the owner explicitly waived the physical touch/typing/back, held-backspace,
annotation and linked-row checks for android0.3.12/source422dc2596, accepting live
repair. this permits regular phone use; it does not qualify those checks or the
emulator journey below. no broad device matrix is required for this prototype.

problem: the outline's emulator journey has never run green. on the owned api 34
avd it must sign in through the real handoff, then: hold a bullet 250 ms to lift
the row (`data-dragging`), move to drag, release below another row to reorder;
hold and release in place to open the item menu (`Select item`,
`Collapse`|`Expand`, `Unlink from …`); after escape, tap a bullet to open its note
(a tap while items are selected extends the selection instead); with a caret in a
nested note, press back once to navigate with the selection unchanged.

impact: the touch grammar and the android proof are unqualified. desktop drag cases
and chromium touch emulation do not cover native touch, the long-press context
menu, the webview's release click or the shell's back. two hazards are known only
by reading:
- the drag claims the release click when the sensor drops a touch press while the
  finger is down (`OutlineDrag.tsx`, `onDragAbort`). that assumes `pointerup`
  precedes `touchend`; a webview that sends `touchend` first would eat every tap's
  click, so bullet taps would stop opening notes.
- dnd-kit cancels a pending touch activation on window `resize`; a hold while the
  soft keyboard or the touch bar changes the viewport never lifts. the release no
  longer opens the note (claimed as above), but the lift is lost.

exact failing step: `openLabAndroid(...).attachPage()` in
`apps/web/scripts/lab/android.ts`. the devtools socket answers `/json/version`,
`connectOverCDP` connects, and the default context holds no page, in two of four
runs. a bounded 20 s post-connection wait (run 4, reverted) saw none. those
runs did not record the target list, so their missing-page cause remains unproved.

evidence, lab runs of the temporary case `outline-android-10-touch` on branch
`outline` at `c71c02f6e` (read-only cold boot of `nexus-api34`, own console port,
`-no-snapshot`); nothing re-ran it on the integrated branch:
- `20261102-121058-cc82c690e636`: the handoff binds the device, and
  `/_nexus/device/startup.json` names the lab reader. right after the deep link,
  `mCurrentFocus` is chrome's `CustomTabActivity` while `topResumedActivity` is
  already the app's `MainActivity`; focus reaches the app within 10 s. seeding then
  went red: devtools `Enter` under the shown soft keyboard never birthed a row
  (likeliest cause, unproven: latinime's composing region makes `structuralInput`
  decline). the case then seeded from chromium.
- `20261102-122505-1d044b28797b` and `20261102-124207-eb9a3cbb01e6`: red at
  `attachPage` (no page in the context).
- `20261102-123051-d7c256471015`: attach succeeds; a 250 ms hold lifts `p` and `c`,
  adb moves paint the indicator, release places through the controller and selects
  `p`. the drop went under `q` (the case aimed at `p`'s text x) and showed a cycle,
  since fixed in the projection and proven on desktop by
  `outline-engine-14-into-following-sibling` (green in runs
  `20261102-135009-cad8cac0e53a` and `20261102-144552-8032b008d8f5`).

re-authoring the case (the temporary file was deleted with the build's cases):
boot the avd per `docs/local-rules/testing-standards.md` but `-read-only
-no-snapshot` on a console port from 5620 that no other emulator holds; build the
debug apk inside the lab with `-PnexusAndroidDebugBaseUrl=<web origin>`,
`-PnexusAndroidDebugOwnedHost=127.0.0.1`, `-PnexusAndroidDebugCaFile=<lab ca>` and
only `NEXUS_GOOGLE_WEB_CLIENT_ID` from the owner's `.env`, passed as
`ORG_GRADLE_PROJECT_nexusGoogleWebClientId`; click the shell's `sign in`, read the
attempt's `hc=` challenge from `dumpsys activity activities`, run the real password
login in the lab's own chromium at `/login?flow=handoff&hc=…` (behind `Use email
and password`), take `handoff_url` from the sign-in route's json and deliver it
with `am start -W -a android.intent.action.VIEW -d <url> -n
app.nexus.android.debug/app.nexus.android.MainActivity`; verify the binding from
the webview rather than window focus; map css to device px with one calibration
press; drive touch with `input motionevent`; read sync status attached, not
visible (a phone keeps it in the closed switchboard).

blockers: the complete outline touch journey and the older attachment failures'
cause. if admission fails again, retain the forwarded port's `/json/list`,
`pidof` (every pid) and `dumpsys activity top | grep -A2 WebView`, then tell a missing target from one
playwright did not surface.

the same attachment failure recurred outside the outline on 2026-11-04 in
selection-annotation lab `20261104-215734-8bec5208dd2a`, using a fresh owned api 34
pixel 6 avd and exact runtime apk. `scripts/lab/android.ts:91` raised
`android lab expected one owned application WebView page` before sign-in.
the annotation's ten browser journeys and static gate passed; native touch
qualification remains pending this attachment diagnosis.

resolved when one run attaches and passes every step above on api 34 with real adb
touch and the real handoff.

playback-cut recurrence, 2026-11-04 at `e00e61c855fe402b55e4294697f6d1523c6ce1b2`:
unchanged natural-advance and fixture-proof journeys each failed at the same
one-page guard before login in an eight-journey native run. the guard did not
record its exact page count. one bounded fresh-reboot retry of each passed
without changing attachment. passive reads of the existing owned forward saw
`/json/version` return 200 while `/json/list` was empty, then one page on the
same package pid/forward in successive samples roughly 0.4 seconds apart.
those observations establish target-readiness lag in the passing attempts;
they do not establish the earlier failures’ cause or playwright page count.
no helper repair or timeout extension was made. this admission issue remains
open, independently of those two completed playback journeys. the observer
was limited to 25 seconds from case start, so missing later observations prove
nothing about attachment. retain the contemporaneous target/process/context
diagnostic requirement above before choosing a repair.

four playback journeys failed the same pre-login guard again at `4a5047881`:
natural advance, catalog refusal, saved artwork and fixture proof. each failing
start's observer saw version 200 with an empty target list, then one owned page
on the same package pid/forward in samples 0.38–0.55 seconds apart. the exact
playwright page counts and rejection-time alignment were not captured. these
observations prove that devtools availability can precede target readiness;
they do not establish every historical attachment failure's cause.

`attachPage` now waits for one page target at the supplied owned web origin
before its single cdp connection, within the existing readiness budget. non-page
targets remain allowed. it then requires one context and one owned-origin page,
reporting safe counts on rejection. retained-data restart uses the same owner;
cleanup, connection deadlines and caller responsibilities are unchanged. this
admission repair does not qualify the outline's touch/typing/back journey or
resolve the separate interrupted-driver mapping record.
