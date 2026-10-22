# lab admission can overtake existing waiters

problem: host slots use nonblocking polling without admission order. a newly
started lab can acquire a released slot before an invocation already waiting;
repeated arrivals can consume its 1800-second admission budget.

evidence: `python/scripts/disposable_runtime.py:475-506` tries both locks every
0.2 seconds. podcast run `20261021-213452-879ea6bd80e0` waited while slot two
changed from `20261021-212931-9e223d5956e3` to the later
`20261021-213756-7a4adfde3b93`. no podcast services had started at 21:39 local.

impact: bounded host load is preserved, but concurrent qualification can be
delayed by newer work. this podcast change does not alter lab admission.

resolved when: existing waiters acquire released capacity in a defined order,
with real concurrent invocations proving that later arrivals cannot repeatedly
overtake them and that cancellation does not strand admission.
