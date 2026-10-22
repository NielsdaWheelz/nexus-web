# retained backup needs the historical x repair before replay

the newest retained r2 archive is a valid 0292 backup, but its historical upgrade
to 0306 refuses before the libraries migration: published x media lacks normalized
source evidence. this leaves recovery dependent on an explicit historical repair
or a newer recoverable archive; stamping it as 0306 is incorrect.

evidence: `releases/99320b630e978dc0fe0d8f727e334e0ea0229a0e/database.dump`,
sha256 `9dde2a203b0480a60937221c822fb6ff2b7826aed5c5ecc76c1ca340bc624dcd`,
restored successfully on 2026-10-22. immutable migrations from `832d8e4b8`
refuse at 0293 with `published X lacks normalized source evidence`, media
`8e08157a-2584-41fd-a5e0-8ffe4bb9a415`.

the same media and reviewed one-row repair are recorded in
`690744421:docs/issues/release-x-thread-imports.md`; `ea3eafdd5` records the
successful production repair and upgrade to 0306. the private reviewed snapshot
is absent locally. production therefore has evidence this retained backup lacks.

resolve by retaining and restoring a verified current-schema backup, or recording
and rehearsing the exact reviewed historical repair. never invent source evidence
or silently discard the affected media. prove restore and upgrade to the current
head with preserved user data. a temporary local rehearsal snapshot alone does
not replace the retained recovery archive.
