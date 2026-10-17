# deleted media metadata jobs block title migration

status: open. origin: 2026-10-14 imports merge qualification. area: metadata lifecycle / deletion.

four pending `enrich_metadata` jobs remained after their task media was deleted through
public operations. imports summary reported no unfinished visible work. normal migration
`0278` correctly refused: `unsettled metadata or x source work blocks x title cutover`.
the read-only census found `media_exists=false` for all four jobs, no open enrichment
llm calls and no unsettled x source work.

this blocks upgrading that database until the metadata owner settles the jobs.
the imports proof recreated only its disposable application database, then ran normal
migrations from empty; it does not prove an upgrade with settled historical jobs.

reproduce: import a pdf with automatic metadata queued, delete it publicly before the
metadata lane settles, stop writers and run the normal `0277` → `0278` migration.
first verify whether an ordinary metadata-worker drain settles deleted-media jobs.
repair deletion/settlement at that owner if it cannot; retain truthful terminal history
and lock ordering. do not bypass the migration guard or rewrite workflow rows manually.

done: public deletion plus normal worker settlement leaves no pending deleted-media
metadata jobs; the unmodified migration accepts the settled database and preserves history.
