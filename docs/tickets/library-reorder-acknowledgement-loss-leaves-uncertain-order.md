# library reorder acknowledgement loss leaves uncertain order

status: open · origin: 2026-10-04 snapshot-owner audit, main `c6eef81c9` · area: web / library write uncertainty

`LibraryPaneBody.tsx:1529–1538` restores optimistic rows after reorder transport
rejection without an authoritative read. `E_NETWORK`, `E_UPSTREAM` or
`E_UPSTREAM_TIMEOUT` can lose an acknowledgement after server commit; rejection
is not proof that the old order remains authoritative. this is source-qualified
low-impact ordering uncertainty, not an executed lost-ack fault.

prerequisite: the snapshot-owner cut is complete (#491). re-admit the current
snapshot/write owner’s unknown-order reconciliation, preserving honest feedback and
generation fencing; no new retry/lifecycle framework. one readback is not a
complete late-write guarantee: client/proxy cancellation does not guarantee
server termination, and the repeatable-read entry query can precede the still
running write's commit (`db/session.py:105–136`,
`library_entry_listing.py:597` uses `lock=False`).

done when actual lost-ack and delayed-completion cases reconcile authoritative
order without claiming failure means rollback or one early read proves no
later commit. this remains outside the selected snapshot-owner slice.
