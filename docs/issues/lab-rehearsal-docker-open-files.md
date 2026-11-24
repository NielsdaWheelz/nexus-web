# docker desktop keeps detached lab source files open after teardown

observed on macbook on 2026-11-24 at `d77bffa5c`. the palette red
rehearsal's lab verified that its owned runtime was removed.
`scripts/rehearse-worktree` in dev-server then retained
`rehearsal-cnj4_r_n/checkout` with `open users still present (pids 32660)`.
`lsof -nP -Fpn +D` names tracked checkout files held by
`com.apple.Virtualization.VirtualMachine`. the checkout is clean.
the retained rehearsal prevents the tool from completing source cleanup
and issuing its evidence hashes. the lab verdict is independent.

the model-availability and journal rehearsals hit the same guard with pid
`62295` after their owned runtimes stopped. model-availability examples include
`rehearsal-dbjra53_`, `rehearsal-p2nm5o5x` and `rehearsal-ig1d_u56`. journal
examples are lab runs `20261124-021749-4e4d643904d2` and
`20261124-021831-472cf9389235`. private evidence is under
`~/.local/state/nexus-reviews/model-availability-implementation.zn9mEw/`
and `~/.local/state/nexus-lab/evidence/journal-navigation-implementation/` on
macbook. the guard cleared older capacity checkouts after docker released
their handles.

reproduce with a detached macbook nexus lab and inspect the receipt and
open paths after owned compose/auth teardown. resolved when the owned
runtime and detached checkout both retire under the existing mount and
open-file checks while other workloads continue. the open handles do
not establish a docker ownership leak or a virtualization crash.
