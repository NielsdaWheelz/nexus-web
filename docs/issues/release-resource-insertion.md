# resource insertion release

this change replaces note-only outline/link routes with the mixed resource-graph
read and command contract. schema 0296, after the article migration 0295,
separates conversation admission order from display order. existing context
ranks are copied; malformed ranks or mismatched
conversation occurrences abort conversion. no content is deleted.

before merge/release:

- rehearse the actual migration on the newest verified production backup. inspect
  any refused rank rows and repair their ownership/order deliberately; do not guess.
- retain wire 12 for the current unreleased client break (the x-thread cutover
  already bumped wire 11). recheck the release boundary if another release lands
  before integration. pair api, web, android and offline consumers; stale clients
  must be refused before writing.
- stop old database writers, retain the verified backup and migrate to the actual
  combined head. start only paired clients; removed routes have no compatibility
  readers. after a committed migration, recovery uses that backup.
- smoke scoped resources on the paired release: inline insertion/cancellation,
  reader selection, mixed rank persistence, preserving unlink and future chat
  context. production writes and cleanup require separate scoped authorization.

deployment, production-backup rehearsal and installed-shell qualification are
separate from isolated integration proof. remove this record after the paired
release and its outstanding checks are complete.
