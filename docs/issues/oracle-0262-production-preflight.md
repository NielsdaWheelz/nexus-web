# 0262 needs a read-only production preflight before deploy

status: open · origin: 2026-10-04 combined oracle landing (cleanup/oracle-reauthor) · area: oracle / production migration

`migrations/alembic/versions/0262_oracle_one_row_readings.py` folds the oracle
event log, folio rows and plate rows into each reading row (its docstring has the
rules), then drops them. stored status is kept; a pending reading's meta becomes
`started_at` (it displays `streaming`, and the job still owns it). it refuses,
before any write and with counts and sample reading ids, on unfinished oracle
work the new code cannot own: a held claim (`running` with an unexpired lease),
or an unfinished job holding a journal the new worker cannot resume (an admitted
or completed generation in the retired snapshot/outcome shape; a completed
failure resumes). pending jobs, expired claims and their journals carry over. it
also refuses on any fold inconsistency (events not 1..n, terminal disagreement,
a folio edge not the reading's own ordinal citation, an unparseable event, meta
disagreeing with its row, a passage citation disagreeing with its phase edge, a
plate whose `oracle_plates.source_url` is not in its frozen 36-row map). it
cancels no reading and deletes no job, journal or key. irreversible: the backup
is the only copy of the log, folio and plate rows, captured activations and
locators, passage-level deep links and undisplayed parent interpretations.

release: `release.py`, crossing 0262, stops the api, waits until the old workers
have finished every oracle job (none pending, running or failed; 20 minutes at
most, else it fails with the workers still running and nothing migrated: rerun),
then stops the workers, backs up and migrates. nothing is forced. before that,
run 0262 against a restored copy of a fresh production backup; it must apply. a
refusal names the readings to inspect. the prod census at 0241 (2026-10-03)
found no passage, plate or bind event, so expect only meta/argument/delta/omens/
done facts and seed-only plates, which show current `corpus.json` metadata: over
the 36 production plate rows (in simplify-04's backup), title and artist are equal
except the Redon record this cut corrects (title, year, attribution); attribution
differs in 35 (34 only by dropped `*italics*` markers) and dimensions in 35 (e.g.
Charon 1000×798 → 727×1000, the asset's real shape).

dry runs over simplify-04's original 0259 backup (sha256 `5d2c4107…`): see the
landing commit. the backup as restored is refused only for its fixture plate
(`example.org`, no production image identity). with that plate repointed it
upgrades 0259 → synapse 0260 → chat 0261 → 0262, and a held claim refuses at 0261
with the database unchanged.

acceptance: 0262 applies to a restored copy of the release backup; delete this
ticket after the release.
