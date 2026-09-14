status: open; source audit, no executed external failure
origin: 2026-09-14 bounded-workspace reporter integration
area: test controller / pinned dependency suites

`python/nexus_test_control/runner.py` requires structured failed-phase evidence
for pytest commands. the plugin is loaded by `python/tests/conftest.py`; pinned
external provider/kernel suites have neither that conftest nor an explicit
plugin argument. their success is unaffected, but failures now report missing
evidence rather than an observed assertion. bounded raw logs remain available.

prerequisite: a reporter import boundary that preserves each external suite's
own environment and pinned dependencies. wire its actual pytest invocation to
that reporter without overlaying nexus application code or dependency locks.
do not synthesize records from console text.

acceptance: a real external-suite assertion retains its phase, type, message
and frame through bounded capture; setup failures stay execution failures and
secrets stay redacted. demonstrate old-source red and candidate green.
