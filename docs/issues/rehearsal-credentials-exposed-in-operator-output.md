# rehearsal credentials exposed in operator output

status: open; retire after isolated qualification
origin: 2026-10-17 book57 coordinator, container-inspection tool output
area: rehearsal secrets

problem: an unredacted docker `.Config` inspection printed the isolated
`nexus-book57-red-inspect-20261016` environment into the session transcript.
this exposed the rehearsal-bucket r2 access key and secret, the local restored
cluster password and temporary application secrets. production credentials were
not present. no credential values belong in this ticket or the pr.

impact: holders of the transcript could access the isolated rehearsal bucket or
use the disposable local secrets where reachable. source/generation/hash fences
remain mandatory; this does not grant production admission.

fix: inspect only named nonsecret fields. after qualification, revoke the exposed
rehearsal storage key through its cloudflare owner and delete its local copies.
retire the disposable clone configuration; do not rotate a shared postgres role
or break preserved task volumes. the old production provider-key issue is separate.

acceptance: storage-key revocation is confirmed, task-owned secret copies are
absent, and preserved resources remain usable. do not call transcript deletion
credential revocation.
