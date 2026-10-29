# owned android emulator exited during qualification

the disposable `nexus-recent-task` emulator on `emulator-5554` exited before
lab `20261028-204748-150a7f2451e8` could start its cases. adb logged the
transport read failure at 20:47:44; its server pid 60995 remained alive, while
qemu pid 53542 was gone. the previous emulator's configured avd root and exit
log were not retained, so the cause is unknown. a fresh task-owned avd has a
separate root and captured emulator log. resolve by identifying the exit cause
and completing isolated native qualification without an unexplained emulator exit.
