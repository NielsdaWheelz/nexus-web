# child job results repeat the handler result contract

status: open. origin: 2026-10-04 backend jobs owner audit at `bbfd1df4`; area: jobs child handoff. priority: p2.

`jobs/process_executor.py:119-134` defines `ChildSucceeded`, `ChildReschedule` and `ChildTerminalFailure` for the same success, `RescheduleRequested` and `TerminalJobFailure` choices already declared as `JobResult` in `jobs/registry.py:26`. the child decoder builds the parallel forms (`process_executor.py:384-413`); `jobs/worker.py:236-246` converts them back before the ordinary queue settlement. this is repeated representation, not an observed failure. bounded ipc serialization and genuinely child-only process outcomes still have separate ownership.

use one handler-result contract across the in-process and child-delivered paths while keeping the bounded json codec, child interruption/timeout/lost-supervisor outcomes, queue policy and exact claim fencing. acceptance: byte-equivalent supported ipc messages and unchanged queue/result/history/domain behavior for success, reschedule and terminal failure in both lanes; child-only interrupt paths still settle as before. qualify current callers before removing the three redundant forms.
