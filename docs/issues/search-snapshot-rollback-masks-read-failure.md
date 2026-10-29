# historical instrumented read failure remains unexplained

status: open; historical attribution only, nonblocking.

source `5a8677968` fixed generic rollback masking. real-postgres red/green proof
preserved the original read exception through a separate real rollback failure,
confirmed backend retirement and completed a subsequent read. receipts remain
private in `.nexus-local/lab/20261028-155653-2805af6a71b1/` and
`.nexus-local/lab/20261028-160346-fc6e4bdbc428/`.

the separate instrumented `324ca2d09` attempt recorded an original `TypeError`
without its message, then exposed psycopg's rollback error, `another command is
already in progress`. its backend retired without new oom/recovery. a later
read-only replay preserved the expected cancellation chain and did not reproduce
the fault. neither the original cause nor an instrumentation trigger is proved;
an owned timeout was not established, so the spent attempt remains a real failure.

close this attribution when the original read/driver lifetime is identified, or
explicitly retire it as unrecoverable history. do not infer a current generic
cancellation defect or add a release gate. the full account and raw-evidence
pointers are preserved in
`.nexus-local/search-takeover-20261028.private/docs-before-final/search-snapshot-rollback-masks-read-failure.md`.
