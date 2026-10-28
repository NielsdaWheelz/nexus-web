# highlight excerpt firefox qualification

problem: the locked headless firefox sometimes stalls during lab startup, before
the application journey. this blocks firefox acceptance; chromium is not proof.

evidence: baseline run `20261028-131809-27acbfe6619c` in the separate
`nexus-highlight-excerpts-proof` worktree reported
`sandbox_extension_issue_file_to_process ... Operation not permitted` and
`RenderCompositorSWGL failed mapping default framebuffer`; the owned process
spun at full cpu. the preceding run reached login and upload. the owned process
and lab were stopped; no shared profile or global browser setting was changed.

resolved when the canonical headless firefox lab path completes the actual
capture, restart and replication acceptance. retain the temporary case until
that witness exists; do not count startup failures as product red.
