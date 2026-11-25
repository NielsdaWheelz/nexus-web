# the headless android emulator can abort during a lab

on macbook, emulator 36.5.10.0 build 15081367 with the stock api 35 image
aborted after launcher readiness during lab `20261124-034008-b1c2848d98a8`.
the native package could no longer be prepared. its emulator log reported
the netsim wifi socket closing. the matching mac crash report
`qemu-system-aarch64-headless-2026-11-24-034516.ips` records
`SIGABRT` in `grpc::internal::CallbackWithSuccessTag::StaticRun` after
`std::__throw_bad_function_call`. the socket closure's cause is unproved.

reproduce with concurrent headless lab emulators on the same mac. resolve
when ending a neighboring emulator leaves an admitted emulator and its adb
transport usable through package setup and teardown.

the exact `42656bc7a` epub offline rehearsal reproduced the same crash before
app setup at 20:42:37 pst on 2026-11-24. the crash report is
`qemu-system-aarch64-headless-2026-11-24-204243.ips` (pid 22579). adb then
reported `emulator-5554` absent during both uptime polling and cleanup. the
lab removed its owned backend runtime. private evidence is
`integration-current-main/android-offline-42656bc7/` in the epub state directory.
