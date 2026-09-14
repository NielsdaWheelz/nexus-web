status: open; source-audited, no execution
origin: 2026-09-14 pr249 merge into bounded-workspace
area: android visual host admission

`python/nexus_test_control/android_visual.py:92,500` still admits its next build
at 2048 mib. `runner.py:397` now requires 3584 mib, but android-visual is absent
from its memory-admitted set (401–426). the public visual adapter calls the
separate gate directly. invocation locking does not supply the raised floor.

reuse the existing memory owner's shared host-floor contract in both callers;
do not add another literal or lifecycle. preserve the physical memory probe and
fail-closed result. the user's physical-device workflow waiver remains in force;
this finding does not request or imply device execution.

acceptance: both build routes enforce the same reviewed 3584 mib host floor;
existing controller/visual checks pass through scripts/test. linux/darwin parser
proofs retain their independent byte calculations below that floor. no reader
capacity qualification follows from this admission correction.
