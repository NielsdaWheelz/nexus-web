# rebase the isolated workspace cutover onto the current release

status: open
origin: 2026-10-16 mobile palette / integration handoff
area: release integration / migration and wire

this feature was built and qualified from `4d5970de7`, at wire 2 and database
head `0287_workspace_title_hints`. canonical main
`eb55608643fd097bc289c42e439b61a09dee0525` uses wire 9 and head 0291; its
0287 is already `0287_suggestion_publications`. replaying the feature's reset
migration or wire constant unchanged would violate the release contract.

do: integrate the feature onto the current canonical head; number the workspace
reset as the next migration, preserve one ancestry, and advance the current wire
once for the required nullable title-hint shape. regenerate browser/native
contracts and qualify matching artifacts. keep the workspace reset; no old shape
or compatibility reader.

acceptance: one canonical migration head; reset changes only saved workspace
state and revision; old clients receive 426 before writes; generated contracts,
api/web identities and matching apk agree on the integrated release. isolated
feature verification is recorded separately and does not qualify main.
