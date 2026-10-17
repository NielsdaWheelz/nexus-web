# large kjv normal import exceeds the parser budget

status: open; campaign disposition awaiting owner
origin: 2026-10-17 book57 real-worker qualification
area: epub extraction / ordinary import

the unchanged 30-second normal parser limit refuses original
`20405d0e-4fda-4cc7-b5e0-04b6a8a724d6` (4,318,345 bytes,
sha256 `bf40df91cf47ed0d1d513e6e910b5a62a839a2edde2b47bd850cbef1c29cc52b`).
on the same devbox at one cpu and 448 mib, deployed `e623be680` refuses at
41,181 ms. book candidate `ebdcda1a1` refuses at 68,543 ms while deriving the
source-proved complete note graph. both outcomes are known; neither published.
candidate source job `7d9fd46b-3457-41f4-a65c-e4b27d00a461` is dead after one
attempt, with a free lease and no oom. it has not been retried.

evidence: campaign `coordinator/followup57-20261016/normal-import-08/` and
`normal20405-baseline-unprofiled/`; the latter is an unprofiled public extraction
call with eight deployed-module hash guards and no database/network/storage write.
local profiling identifies repeated whole-document identity scans; it does not
prove that removing them is sufficient. retained-publication maintenance passes
its separate 120-second parser / 180-second invocation limits.

keep ordinary limits unchanged. decide explicitly whether normal-import capacity
is separate from this maintenance campaign before claiming its acceptance. any
performance correction belongs to the measured extraction owner, preserves the
complete source-approved projection, and needs actual worker proof. no raised
budget, partial-body fallback, source alteration or global canonicalizer rewrite.

resolved when the unchanged original completes one ordinary worker attempt under
the existing 30-second, 448-mib, zero-extra-swap limits and its complete persisted
notes match source proof. a campaign exception is a disposition, not resolution.
