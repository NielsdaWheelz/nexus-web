# live source hash probe restarted the api container

status: open
origin: 2026-09-27 processing release preflight
area: production api / operator source verification

a read-only `docker exec` python probe in `nexus-api-1` selected four retained
`media_file` rows and began hashing their r2 objects through
`get_storage_client().stream_object`. it printed no result, exited `137`, and
the api container restarted once (`RestartCount=1`, `OOMKilled=false`). the
exact cause is unknown. subsequent container health was `healthy`, postgres
and both workers were healthy, and public api/web `/version` returned 200.
there was no database write. the probe was not repeated.

prerequisite: keep bulk object reads out of the live api container. use an
off-host bounded reader or an isolated restored rehearsal for exact-byte
correspondence; inspect the container limit and exit evidence before reusing
this method.

acceptance: exact retained source bytes are verified with measured bounded
memory and no production container restart; the chapter repair rehearsal uses
those verified bytes.
