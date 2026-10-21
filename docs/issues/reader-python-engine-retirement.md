# retire the reader-python verification engine after qualification

status: open
area: local verification infrastructure

`c3rp` is the remaining campaign colima profile. the active reader-python
workflow in `../nexus-web-c3-rpy` still uses it; its twelve containers were
running during the 2026-10-20 storage cleanup. the harness owner is
`../nexus-web-campaign-artifacts/2026-10-20/rpy/harness/engine.sh`.

after the workflow finishes, remove its containers and retire the profile with
`colima delete c3rp --data --force`; stopping alone retains its images and disk.
preserve the host worktree, harness and corpus files. the harness's delete arm
now includes `--data`. new application qualification uses the configured engine
and compose namespaces under `../local-rules/testing-standards.md`.

resolved when reader-python qualification is complete and both
`~/.colima/_lima/colima-c3rp` and
`~/.colima/_lima/_disks/colima-c3rp` are absent.
