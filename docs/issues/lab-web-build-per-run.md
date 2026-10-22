# lab web build can never be reused

problem: each lab run binds fresh random ports (`python/scripts/disposable_runtime.py:458-474`)
and generates a fresh publishable key (`:535`). the web build bakes both through
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`:756-757`).
every run therefore performs a full production build (`:765-773`).
testing-standards documents this cost as "one production build per run".

impact: every run pays a full `next build` in cpu and writes a fresh `.next`, even
when the commit is unchanged.

evidence: on 2026-10-21, 36 lab `web-build.log`s report "Compiled successfully"
in 8.9-109 s (median about 13 s; static generation follows). one checkout's
`apps/web/.next` is 539 mb.

fix: slot-derived ports, a per-checkout stable publishable key, and reuse when
sha, clean `apps/web`, slot and key match ([lab-host-budget](lab-host-budget.md) §6).
runtime-injected public config is rejected as a test-only seam.

resolved when a second run at the same sha with a clean `apps/web` skips the
build, and testing-standards states the reuse rule.
