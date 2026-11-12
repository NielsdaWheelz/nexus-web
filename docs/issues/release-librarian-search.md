# librarian search cutover

implementation authorized 2026-11-12. deployment remains a separate action.

baseline: `release-librarian.md` records wire 21/schema 0341 deployed 2026-11-12.
this change uses wire 22/schema 0342. replacing prose `role` with nullable message
metadata breaks the resource shape; migration 0342 publishes existing retained
partial answers to the keyword index without changing canonical messages.

before shipping:

- reconcile `fix/librarian-responsiveness` before release: its current head
  `9b435d881` also changes `Librarian.tsx` and `ChatSurface.module.css`. preserve
  the search/transcript ownership split when integrating the independent work.
- confirm actual migration head and last released wire before merging. share an
  already-taken pre-release wire bump; never bump twice between releases.
- qualify the frozen migration on a predecessor-schema fixture backup through
  `./scripts/lab --database-backup FILE -- …`; prove old partials become searchable
  without changes to canonical text, ids, timestamps, turns or action receipts.
  permit pending messages; they remain unprojected.
- use canonical stopped-writer and verified-backup deployment. pair api, web,
  android and extension assets; retain authored replicas and unsynced writing.
- qualify deployed search → passage → back, accepted-send history and partial
  results. the owner explicitly waived the physical phone keyboard/landscape
  check on 2026-11-12. headless geometry does not verify the real ime; the existing
  header-interception issue remains open.

resolved when paired release/migration and client acceptance are recorded in
the release pr. recovery requires paired compatible assets and verified backup;
no backward reader, lazy repair or mixed-wire operation.
