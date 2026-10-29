# android lab timeout leaves owned mappings

an android playwright case timed out during real certificate/login setup. its
enclosing lab tore down, but the task-owned emulator retained adb reverses
`tcp:31003 -> tcp:54545` and `tcp:31001 -> tcp:31001`. the next
`openLabAndroid` refused with `android lab reverse port is already owned`.

observed 2026-10-28 on isolated `emulator-5630`, from the mobile-pane-opening proof
checkout. `apps/web/scripts/lab/android.ts` owns these mappings and its `close`
cleanup; test timeout can end the driver before cleanup completes. after verifying
the old lab and driver had ended, only those two mappings were removed; the
device's reverse list became empty. no other device or mapping was touched.

impact: interrupted installed qualification needs exact owned-resource recovery
before a subsequent invocation. this is separate from pane-opening behavior.

`629c62c7f` repairs a narrower close-path stall: package, transport and mappings
retire before bounded cdp disconnect. the paused-renderer close passed in
`20261028-203808-cc37cb7f1970` in 291ms. this does not establish cleanup after a
driver timeout interrupts or bypasses that close path.

resolved when a deliberately timed-out installed driver leaves no owned mappings,
or the existing lab recovery owner records and reliably removes those exact
mappings after verified shutdown. preserve refusal of mappings owned elsewhere.
