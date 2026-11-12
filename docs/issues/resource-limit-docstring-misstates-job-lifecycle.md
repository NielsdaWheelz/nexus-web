# resource-limit docstring names the wrong job state

`python/nexus/errors.py:247-251` says a resource-limit job goes dead.
`python/nexus/jobs/process_executor.py:91-95` instead maps memory/time to
`bounded_retry` and structural/output limits to `hold`; `jobs/queue.py` owns the
resulting transitions. held work is distinct from dead intent and does not
invoke the dead-intent callback.

the wording caused an incorrect source-attempt failure inference during the
acquisition review. correct the docstring to describe the actual dimension and
disposition contract without changing behavior. resolve when it agrees with the
transition owner. application code was outside this documentation cleanup.
