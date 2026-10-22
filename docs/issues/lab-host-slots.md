# host budget needs exclusive admission and campaign convergence

problem: ordinary labs now share two persistent host `fcntl.flock` slots in
`python/scripts/disposable_runtime.py`, while retaining `.nexus-local/lab.lock`.
waits report holder run ids and fail after 1800 seconds; admission spans image
acquisition through teardown, and descriptors stay out of child processes.
exclusive acquisition remains deferred until the real `--client-throttle`
consumer ships. the copied campaign harness must also retire its separate
pid-reclaiming slots (`nexus-web-campaign-artifacts/2026-10-09/harness-slot.sh`).

impact: on 2026-10-21, two lab stacks and a campaign cycle (in its own colima vm,
with 24 host cpu burners) ran beside interactive work. host load reached 147-162
and memory pressure reached warn.

evidence: at that time, 5 worktrees had lab runs, and 2 lab stacks plus the
campaign were up.

fix: two `flock` slots on the host filesystem, with the whole budget for
throttled runs ([lab-host-budget](lab-host-budget.md) §4).

resolved when a third concurrent invocation waits with the holder shown, a
throttled run excludes both others, and `harness-slot.sh` is no longer used.
