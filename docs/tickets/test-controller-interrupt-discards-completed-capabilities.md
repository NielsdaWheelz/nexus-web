# oi-084 — interruption discards completed capability evidence

status: open
origin: 2026-09-12, reader document-map confidence run `b769ea9c59cb2671`
area: test controller, workflow evidence

## defect and evidence

the confidence run at `01e5862d89c65ee7649394b0297a84d124740c8f`
was deliberately interrupted during `kernel-python`. its summary instead marks
`policy` failed with `test control interrupted by SIGINT`, every later capability
`not_run`, and every capability duration zero. no command logs are retained.

before interruption, bounded reads of the owned pytest process
`/proc/2574981/fd/6` observed completed release-harness cases and progress through
89%. this establishes that kernel execution occurred; these transient observations
are not formal passing gate receipts. the interrupted summary cannot substantiate
the earlier completed policy/static results.

`python/nexus_test_control/runner.py:1135` constructs the entire capability tuple
before returning it. an exception during iteration loses the already yielded
records. `python/nexus_test_control/cli.py:347` leaves `failure_owner` at the first
workflow capability; its exception handler at line 357 replaces the results via
`_failed_capabilities` at line 611. that replacement invents the first-capability
failure and zeroes all other execution evidence.

## correction

prerequisites: none. preserve completed capability records and the current owner
across interruption. retain the interrupted owner's bounded command evidence,
report its actual interruption, and leave only unstarted capabilities `not_run`.
keep owned-child cleanup and an overall non-passing result. do not infer passes
from log text or relabel cancellation as a product assertion failure.

## acceptance

interrupt a controlled workflow after completed policy/static stages and during
a later command. the resulting receipt retains the completed statuses, durations,
metrics and artifacts; identifies the interrupted capability; marks subsequent
stages unstarted; and records cleanup without claiming a passing workflow.
