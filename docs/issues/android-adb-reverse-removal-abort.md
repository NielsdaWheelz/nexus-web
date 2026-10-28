# adb reverse removal can abort the host daemon

platform-tools37.0.0-14910828 on macos27.0.1 aborted twice while removing
an active owned web reverse. crash reports225024/230525 showSIGABRT in
`handle_packet`; the adb log reports `adb.cpp:525` disallowing a late connect
to the removed listener. the device remained connected; the restarted daemon
had lost all mappings. original failed cleanup receipts remain private.

the installed reading qualification instead used the existing tcp gate to close
pooled connections and reject new ones, retaining the reverse until mandatory
final cleanup. reading and cleanup then passed; no global sdk, daemon or device
configuration changed. this does not affect the installed product.

keep this tooling hazard for an upstream adb fix or deliberate tooling update.
resolve after the affected reverse-removal schedule and exact owned cleanup work
on the replacement tool version without a daemon abort.
