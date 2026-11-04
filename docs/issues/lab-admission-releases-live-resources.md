# lab admission can release capacity before the runtime is gone

at fetched main `aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`,
`python/scripts/disposable_runtime.py:411-413` starts separate host process
groups, and the lab also starts detached containers. host-slot descriptors are
held only by the runner (`619-651`, `1362-1363`). a hard-killed runner therefore
releases its slot while its services can survive. another checkout can acquire
that slot and fail on its fixed ports (`665-677`); released admission also does
not prove released memory. checkout recovery is explicitly manual (`38-42`).

observed during feedback-homes qualification on 2026-11-02: runner pid27016
for `20261102-201924-92036acadcdd` disappeared while its recorded host groups
and detached stores survived. why the runner exited is unknown; this was not
a deliberate crash test. a different checkout acquired unlocked slot4 and
failed before its driver because `127.0.0.1:31030` remained held by
`c0ea2872190a`, the exact run's postgres container. its compose working directory
was the owning `p2-l4/docker`. several later runs hit the same occupied port.

the owner verified current commands and working directories against the run's
`launches.json`, drained only those groups, and ran both recorded recovery
commands successfully. container, volume and network queries for its exact
compose/auth labels were empty; the port had no listener. only then were the
recorded private inputs, socket directory and matching checkout lock removed.
no shared slot state, daemon settings or unrelated runtime changed. the
interrupted qualification run has no final result and must be rerun.

a different checkout observed on 2026-11-03 at 04:27 utc: run `20261102-202534-7e1839c3d588`
failed before its driver with `lab slot 4 port 31030 unavailable`.
container `c0ea2872190a` (`nexus-lab-20261102-201924-92036acadcdd-postgres-1`)
held that port; the other runtime's auth/storage/workers also remained. no owning
disposable-runtime process remained, and codex child 27208 had ppid 1. this
establishes occupied capacity after admission release, not the cause of that
supervisor's exit. that observer changed nothing in the foreign runtime;
the owning feedback build performed the recorded recovery above.

accepted limit of the parallel-labs change: hard kills require manual recovery.
the operator reconciles exact recorded ownership before reusing the affected
checkout or ports; never kill a saved pid blindly. automatic prevention would
require separately scoped admission recovery. resolved when supervisor loss
cannot admit replacement work against occupied capacity, and recovery leaves
an unrelated lab intact.

observed 2026-11-02 during feedback phase two: p2-l2a runs
`20261102-202853-8c27d8c72349` and `20261102-203021-b5b77046da3a`
claimed slot 4, then exited 125 before the driver with
`lab slot 4 port 31030 unavailable; inspect the port owner`.
read-only lsof identified docker desktop pid 6340 listening at
`127.0.0.1:31030`; the original runtime owner was not established.
one controlled retry was exhausted. no runtime, daemon, slot or process
was changed. this confirms occupied capacity after admission, not the
supervisor-loss cause above. normal admission and scoped cleanup must succeed
before the pending reader qualification can claim green.

root traced that listener to l4's recorded orphaned
`20261102-201924-92036acadcdd-postgres-1` and performed its exact scoped recovery.
normal admission and cleanup then succeeded for reader run
`20261102-203346-4f6ba6330105`. this restores qualification capacity; it does not
prove or repair the supervisor-loss cause.

playback runs `20261102-202453-e6d5b609aa16` and
`20261102-202602-27b23ed79f25` independently hit the same slot4/31030 refusal
before their drivers. read-only inspection named that same orphaned postgres
container; neither observer touched the foreign runtime. this adds recurrence,
not a second cause or recovery owner.
