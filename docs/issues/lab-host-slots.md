# heavy local verification has no host-wide budget

problem: the lab's only lock is per checkout (`python/scripts/disposable_runtime.py:230`,
`.nexus-local/lab.lock`). campaigns use a separate two-slot mkdir lock that
reclaims slots by pid (`nexus-web-campaign-artifacts/2026-10-09/harness-slot.sh`).
release lanes use neither. nothing bounds lab runs, campaign cycles and release
lanes together.

impact: on 2026-10-21, two lab stacks and a campaign cycle (in its own colima vm,
with 24 host cpu burners) ran beside interactive work. host load reached 147-162
and memory pressure reached warn.

evidence: at that time, 5 worktrees had lab runs, and 2 lab stacks plus the
campaign were up.

fix: two `flock` slots on the host filesystem, with the whole budget for
throttled runs ([lab-host-budget](lab-host-budget.md) §4).

resolved when a third concurrent invocation waits with the holder shown, a
throttled run excludes both others, and `harness-slot.sh` is no longer used.
