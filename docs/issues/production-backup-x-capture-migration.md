# x capture conversion rejects known historical unknown timestamps

the unmodified `nightly/2026-10-28/database.dump` restores, passes the repaired
bibliography conversion 0322, then aborts before annotation conversion in
`migrations/alembic/versions/0324_x_capture.py:150`:
`RuntimeError: 0324 x source 01a1627e-bfd1-79d8-a3ea-a04c827487df lacks one dated original fragment`.

observed on `cde84058f97bf606510af3a694b90c2161a3e48a` in private lab
`20261028-202210-b2359c156cb4`. the restored postgres container and volume were
removed; production was untouched. this blocks full production-backup upgrade
qualification and paired release, not static consistency or isolated annotation
conversion. see [x capture release](release-x-captures.md) for the owning census.

2026-10-29 read-only production census at schema 0317 establishes the failed
premise: 97 of 108 sources have null `body_captured_at`; all 97 have exactly one
fragment at index zero, with retained provider payload. all also have null
`checked_at` and `logical_post_id`. the reported uuid is the first of that cohort,
not evidence of a missing body. no production data was changed.

historical migration 0293 at `690744421`,
`migrations/alembic/versions/0293_x_thread_sources.py:1878-1885`, explicitly writes
these unknown observation times as null. retained production verification of
0292-to-0306 at `99320b630` records 97 canonical posts; every affected current
media id appears in its reader map. the new converter rejects a historically
valid representation. copying a fragment creation, attempt completion, post
publication or migration date would invent capture provenance.

affected records include six highlight anchors, one attached annotation note,
57 thread memberships, 68 incoming embeds, 42 library entries, 186 incident
resource edges, four retrievals and one reader-state row. these counts overlap
and do not yet inventory json-embedded destinations. exact private census:
`nexus-x-census-opev6bzp`, initial output sha256
`cbc89e55f98e9e7744549022c6648bec10aad927da716fc5450a8f46d2e39bd8`;
dependency output `69128d4725f5b7520bdae3aa49e6b4fe32009ebc5e169cc3d2dd1afa62ae9854`.

correct the unshipped capture conversion and its canonical timestamp contract to
preserve known bodies with unknown capture time. keep strict body/identity
validation and require times for newly acquired observations. review reader
`saved_at` separately: it currently assumes a capture time exists. qualify this
proposal on the restored corpus; no timestamp synthesis or deletion is authorized.

resolved when the same corpus passes the normal upgrade through current head and
all preserved writing, reference and source-prefix checks.
