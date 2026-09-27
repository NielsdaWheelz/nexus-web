# production chapter repair correspondence unverified

status: open
origin: 2026-09-26 chapter implementation session
area: production reader migration / selected epub repair

the four exact local edition digests and isolated imports pass chapter acceptance,
but production media ids, retained original digests, fragments, offline pending
progress, and source/row correspondence remain unknown. `ssh
nexus@5.78.194.235` and `ssh dev-server-public` both timed out on port 22
on 2026-09-26; the earlier council inspection had the same blocker. no production
schema, publication, or offline state was changed in this branch.
the owner explicitly deferred production acceptance for this pass.

prerequisite: restore a read-only production route and identify the affected
rows and exact stored originals. rehearse `reader_navigation_repair inspect` on
their isolated restored state, back up affected data, and establish a no-use
cutover window and pending-progress disposition before applying migration and
repair through the deployment runbook.

acceptance: exact production source/row correspondence is recorded; the four
specimen tuples, old-package recovery, retained content/annotation identities,
and generation fences pass on a restored rehearsal and then on the deployed
artifact. no pending progress bytes are discarded.
