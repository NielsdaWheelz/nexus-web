# a daily capture shows its own day as a removable Connection

status: open · origin: 2026-10-04 synapse harness (baseline N3, seen again on the reauthor run) · area: notes / resource graph

capturing a daily note (`POST /notes/daily/{date}/captures`) writes a
`user`-origin `context` edge note → daily page. every daily note's Connections
therefore lists its own day ("October 4, 2026 · context") with Edit connection
→ Unlink connection (harness exploration of note1, 2026-10-04). the D7 journey
counts it: a note with 101 page links shows 102 rows.

prerequisite: the owner decides whether the day is a structural parent (not a
user assertion) or a link the user may remove.

fix: if structural, write it with a structural origin (or not at all, since
the page owns the block) and keep it out of Connections; if a user link,
leave it and close this ticket.

acceptance: a fresh daily note's Connections lists only the user's own
assertions, or the decision to keep the link is recorded here.
