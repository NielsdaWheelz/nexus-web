# the deployed compose and release.py cannot boot the candidate

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: release artifact / gate g

## what is wrong

`git status --porcelain deploy/` is empty. nothing supplies
`API_READ_ADMISSION_LIMITS`, `IMAGE_DECODER_LIMITS` or
`READER_PUBLICATION_LIMITS` outside the test controller
(`python/nexus_test_control/services.py:451-453`), yet `python/nexus/app.py:142-143`
calls `configured_read_admission()` and `require_image_decoder_limits()` in
`lifespan`, and both raise `RuntimeError` when their profile is absent. deploying
the candidate image as configured today produces an API that refuses to start.

separately, `deploy/hetzner/docker-compose.yml:63-65` still reads
`mem_reservation: 192m` / `mem_limit: 320m` / `memswap_limit: 320m`, while
`bounded-workspace-runtime-progress.md:234` states that "neither current 320MiB
nor any replacement has qualified" and every successful candidate receipt
(`08c371ca397dd14e`, `c243cd943a90b130`, `b2dd452e8f455625`) was taken at 512 MiB
with peaks of 422–435 MB.

`deployment.md` names the profiles and says to "provide the release-qualified
profile" — an instruction with no owner, no default and no release-controller
check.

## prerequisites

the qualified numbers, i.e. the capacity run. this ticket is the release-side
half; gate 0/a owns the measurement.

## proposed fix

make the resource contract part of the release artifact rather than tribal
knowledge:

- have `deploy/hetzner/release.py` refuse a deploy whose captured config file
  lacks all three profiles (and every field of each, `request_bytes` included).
- land the qualified values plus the new `mem_limit` in
  `deploy/hetzner/docker-compose.yml` as one change, with the qualification
  receipt id in its comment.
- add a startup readiness assertion that reports the active profile, so the
  post-release receipt can confirm what the deployed artifact is actually running.

do not give the pydantic fields defaults. a silently defaulted capacity profile is
exactly the "guessed replacement ram" gate 0 forbids, and it would let an
unqualified number reach production without a receipt.

## acceptance

`release.py` refuses a config missing any profile field; the deployed compose
carries the qualified `mem_limit` with its receipt id; and the post-release
readiness output names the active profile.
