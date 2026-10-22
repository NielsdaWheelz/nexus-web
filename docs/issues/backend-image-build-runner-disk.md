# backend images fail to build: the runner lacks disk

status: open · 2026-10-22 · area: release / ci

the `backend images` workflow has failed on every main commit since `bff5509be`
(#727), six in a row through `1f25cbbdb`. the self-hosted build runner has
5.70 GB free at `/home/niels/.local/share/docker`, and the build needs 8 GiB.
failed runs cannot be re-run.

impact: no backend image exists for main's head, so main cannot be released
(`deploy/hetzner/release.py` deploys only published images). the newest image
is `bff5509be`'s, which lacks #728–#735.

fix: free at least 8 GiB on the runner (old images and build cache), then land
any commit on main to start a fresh build. the host budget
([lab-host-budget](lab-host-budget.md)) owns the runner's ceilings.

resolved when: `backend images` succeeds on main's head and keeps succeeding.
