# browser capacity experiments lack an execution memory ceiling

status: open
origin: 2026-09-13 bounded-workspace qualification
area: test controller / browser capacity

`python/nexus_test_control/runner.py` admits heavy work with2,048mib available
memory and a shared lock. `memory.py` samples usage; neither owner constrains
browser memory after launch. the launch floor is not a protected host reserve.
a dense64mib table experiment could exhaust this7.6gib host despite admission.

prerequisite: measure128k/512k/2mib dense-table steps and actual visible-view
counts first. larger qualification needs an exact controller-owned memory bound
or a sufficiently provisioned dedicated host; do not guess safety from payload
bytes or silently narrow the supported source contract.

acceptance: retained receipt binds the large experiment to its execution ceiling
and host reserve, or records it as not run. ordinary browser proof remains on
the existing controller; no alternate launcher or global process cleanup.
