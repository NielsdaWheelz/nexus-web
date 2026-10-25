# preserved rehearsal password in operator output

on 2026-10-21, a read-only `docker inspect c3rh-pg` printed its environment,
including the preserved local postgres password, into an internal tool transcript.
no value is copied here. production credentials were not inspected.

the original container was stopped and remained untouched. the search task's
separate volume clone and container were removed; that does not revoke the
preserved cluster's password. do not rotate a shared role or destroy the saved
rehearsal as incidental cleanup.

resolved when the credential owner determines the transcript retention boundary
and, if the value crossed it, replaces that credential through the preserved
rehearsal's owner and confirms it remains usable.
