# production backup stops before annotation migration

the restored `nightly/2026-10-28/database.dump` at revision 0317 cannot reach the
annotation cutover. the normal upgrade aborts in
`migrations/alembic/versions/0322_contained_work_metadata.py:114` with
`RuntimeError: malformed bibliography result: f6ed51ac-ad47-4184-b5a8-9b779ec68b6c`.

observed on annotation head `222b36442ef2ab90bc02d9a8a19390e481f13997` in private
lab run `20261028-185229-b6002185f5f1`, after archive validation and full restore.
the isolated postgres container and volume were removed. production was untouched.

this blocks full production-backup migration qualification and release. inspect
the retained job payload/result against the historical producer contract; repair
explicitly or correct conversion at its owner without bypassing refusal. resolved
when the same unmodified backup upgrades through the current head with required
data-preservation checks passing.
