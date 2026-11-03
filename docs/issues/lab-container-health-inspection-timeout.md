# lab container-health inspection times out

three independent feedback-homes labs on 2026-11-02 stopped when docker health
inspection exceeded ten seconds. one exact run is
`20261102-194125-a62ad13a30c3`: worker-background startup inspection timed out,
owned cleanup completed, exit 125. another run had reached the browser cases
before the same supervision failure stopped its driver. interrupted cases are
unqualified, not product failures.

`python/scripts/disposable_runtime.py:1203` bounds the health command at ten
seconds; the runtime also supervises container liveness at `:556`. host load or
daemon delay is a possibility, not an established cause. docker was neither
restarted nor reconfigured. existing lab slots and other sessions were untouched.

resolved when the cause is established and equivalent concurrent owned labs
complete with health supervision and cleanup intact. do not weaken liveness
checks or claim interrupted browser journeys passed to bypass this failure.
