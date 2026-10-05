# concurrent x author admission duplicates media

status: open · origin: 2026-10-04 cleanup/linear-02 spec review · area: source identity

distinct request keys can both miss the same x author-thread source, then create
two media, attempts and jobs. the lookup has no source-identity lock and these
rows have neither canonical URL nor provider ID for a unique constraint to arbitrate.

source evidence at `557aed14f1d88bdb2b1bc9856944ce433e38f115`:
`media_source_ingest.py:323–332,381–394,765–774,835–852`;
`migrations/alembic/versions/0236_baseline_schema.sql:5349,5363` indexes exclude
the nullable identity. later library locks cannot repair two independent media.
this is source-qualified; no live race or provider execution is claimed.

prerequisite: define the author-thread admission identity already carried by
`provider_target_ref`. serialize its acquisition at that owner, preserving
thread membership and the stored first-key receipt; keep request-key replay separate.

acceptance: two controlled distinct-key admissions for one thread commit one
media/attempt/job and both requested filings; replay and different threads remain correct.
