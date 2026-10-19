# url reuse after hard delete raises a foreign key defect

status: open · origin: 2026-10-04 cleanup/linear-02 spec review · area: source reuse / deletion

reuse can load a media before a completed hard delete. its raw reference barrier
then finds no row and silently returns; filing or attempt creation still uses
the cached ID and can violate a foreign key. refreshing a missing ORM row is
also a defect, not a domain refusal. the source admission lacks a missing-row
decision at the identity/reference boundary.

source evidence at `557aed14f1d88bdb2b1bc9856944ce433e38f115`:
`media_source_ingest.py:771`, `library_entries.py:301–314,386`,
`media_deletion.py:479,486`; baseline schema foreign keys at `6555,6683`.
neither foreign key is shared retry-allowlisted. candidate `7d8573e650802a669dd9206bedf4c6a5c8cc2cb0fd4a9c941d5959634e98a742`
refreshes a reused viewer row after filing but adds no missing-identity decision.
this is a source-qualified schedule; no runtime 500 reproduction is claimed.

prerequisite: preserve media-before-library lock order and teardown authority.
make deletion-first explicit at the locked admission identity, either restarting
acquisition or returning the correct domain refusal; do not retry arbitrary foreign keys.

acceptance: a controlled lookup→completed deletion→reference schedule produces
a coherent admission/refusal with no orphan, foreign key or refresh defect;
creator-first retains its reference and pending teardown still refuses filing.
