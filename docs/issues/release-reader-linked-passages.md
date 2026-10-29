# release reader linked passages

problem: production `3d81ef45` misclassifies foreign linked passages as
unavailable. the repair is implemented and locally qualified on
`codex/reader-linked-passages`; production qualification remains pending.

owner decision: ship with the next full main release. this fix adds no migration;
the full release retains its own migration, backup and client-pairing obligations.

release through `deployment.md` and `./deploy/hetzner/deploy.sh <full-sha>` in the
planned no-use window. no manual compose/alias changes or regenerated links.
run canonical `release.py --check`, establish matching release identities, then
compare bounded authenticated connection/document-map reads for existing
epub/pdf/web targets and check actual navigation. compare one existing valid
historical media/span citation read-only before/after release: frozen evidence
and its occurrence activation survive. keep owned authored quote rendering's
separately recorded issue outside this control. no production fixtures.

application-import diagnostics must run outside the serving api cgroup: exact
deployed source, one explicitly read-only connection with bounded sql timeouts,
tunnel closed afterward. do not repeat the diagnostic memory incident.

resolved when the deployed candidate restores those targets and navigation,
preserves the citation control, and all canonical release checks pass. remove
this record and the original defect record when their acceptance is met;
put the actual proof and limitations in the pr.
