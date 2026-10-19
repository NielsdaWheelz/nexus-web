# node runtime pin differs from vercel

status: open; release behavioral controls use the hosted major
origin: 2026-10-13 release, pr #576 gateway review
area: web / runtime configuration

`.node-version:1` specifies 22. the live vercel project
`prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs` reports `nodeVersion: 24.x` through
its management api. `scripts/test` and the self-hosted ci workflow use
`node` from the runner path. a passing local fetch control therefore does
not establish behavior on the hosted runtime. this review caught the
discrepancy before qualification and reran forwarding controls on official
node 24.21.0; node 26 evidence is retained separately.

choose one declared web runtime major and have local setup, ci and vercel
consume or verify it. keep this with the planned tooling ownership work;
do not change a running release's runtime merely to match a stale local pin.

acceptance: the declared major, fresh ci runtime receipt and live vercel
project setting agree; a clean web build and the affected transport checks
pass on that major. release evidence is under
`2026-10-13/release/bff-gateway-recovery/` in campaign artifacts.
