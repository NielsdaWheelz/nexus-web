# librarian companion cutover

baseline: `release-librarian.md` records deployed wire 21/schema 0341.
main at `a36bf6d9a` already takes wire 22/schema 0342 for librarian search.
this change shares that unreleased bump: required rich-reference output fields,
attachment resolution route and workspace companion vocabulary ship together.
no schema migration, legacy reader or mixed-wire path is introduced.

before release, verify the actual deployed wire has not advanced past this
baseline; if wire 22 has shipped meanwhile, assess one new release bump before
merging. pair api, web, android and extension assets through the canonical
release owner, retaining authored replicas and pending writing. qualify source
follow/back and a published citation in installed clients.

resolved when paired deployment and installed acceptance are recorded in the pr.
