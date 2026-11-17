# activity ingest accepts positions beyond a work's length

status: open · found 2026-11-16 · area: consumption activity

ingest validates the time window, access, capture identity and overlap, but not
word positions against the work's length or kind
(`python/nexus/services/consumption/activity.py`, `record`). a client defect can
therefore store impossible positions. ordinary pdf clients send no word pair,
but a crafted activity batch can supply one.

the reading record excludes implausible jumps from coverage and pace while
retaining their observed time (`stats.py`, `_base_sql`). that repairs the
record's interpretation; it does not validate the source measurements.

fix: validate supplied positions against the canonical work's measurement and
length at ingest, without inventing observed progress for missing measurements.

resolved when an activity request with word positions beyond the work's length
is refused or explicitly clamped under the chosen ingest contract.
