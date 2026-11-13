# release branch creation did not publish images

on 2026-11-12, pushing existing commits to new branches
`release/20261112-native-cutover` (07f1ee58a) and
`release/20261112-native-cutover-code` (d45241d73) created the refs but no
`backend-images.yml` run appeared. the latter commit changes
`python/nexus/services/atlas.py` and the worker env example, so this observation
is not explained merely by the former commit's documentation-only delta.
`gh run list --workflow backend-images.yml` still ended at main's fd7707d87
run43240075373; the workflow was active and declares `release/**` push admission.

these source commits have no deployable candidate. do not substitute local
images or relabel another candidate. use the normal merged-main push and its
first-attempt candidate for the current release. inspect github event/path-filter
behavior before relying on branch creation as an early publication mechanism.

the librarian release repeated this with existing source `ff4862ac9`: creating
its release branch produced no run. advancing that existing branch to new source
`9b435d881` did produce eligible first-attempt run `43318699213`, which was
deployed successfully. this establishes a working branch-update path, not the
cause of the missing branch-creation events.

resolved when the exact supported release-branch push procedure produces an
eligible first-attempt artifact, or the runbook narrows its publication promise
with the demonstrated event limitation.
