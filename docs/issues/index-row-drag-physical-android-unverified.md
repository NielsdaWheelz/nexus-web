# index row dragging physical android acceptance

problem: physical android gesture acceptance is unverified. browser or emulator
proof cannot establish touchscreen timing, scrolling or native context menus.

evidence: on 2026-10-20, local `adb devices -l` listed only `emulator-5580`.
the owner explicitly requested browser/emulator proof and physical checks recorded
as not run. implementation and automated/static proof are separately qualified.

resolution: on the delivered source, use disposable own library/lectern records
on a physical android device. verify swipe scrolling/pull-to-refresh, hold-drag,
escape/cancellation and release without navigation/refresh, a second contact,
context-menu behavior and the next independent gesture. record the exact source,
device/app identity and actual observations; then delete this record.
