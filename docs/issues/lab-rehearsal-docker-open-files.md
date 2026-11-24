# docker desktop keeps detached lab source files open after teardown

observed on macbook on 2026-11-24 at `d77bffa5c`. the palette red
rehearsal's lab verified that its owned runtime was removed.
`scripts/rehearse-worktree` in dev-server then retained
`rehearsal-cnj4_r_n/checkout` with `open users still present (pids 32660)`.
`lsof -nP -Fpn +D` names tracked checkout files held by
`com.apple.Virtualization.VirtualMachine`. the checkout is clean.
the retained rehearsal prevents the tool from completing source cleanup
and issuing its evidence hashes. the lab verdict is independent.

reproduce with a detached macbook nexus lab and inspect the receipt and
open paths after owned compose/auth teardown. resolved when the owned
runtime and detached checkout both retire under the existing mount and
open-file checks while other workloads continue. the open handles do
not establish a docker ownership leak or a virtualization crash.
