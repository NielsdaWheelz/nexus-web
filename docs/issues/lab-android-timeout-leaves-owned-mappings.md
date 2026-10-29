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

resolved when a deliberately timed-out installed driver leaves no owned mappings,
or the existing lab recovery owner records and reliably removes those exact
mappings after verified shutdown. preserve refusal of mappings owned elsewhere.
