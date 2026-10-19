# resource insertion release

this change replaces note-only outline/link routes with the mixed resource-graph
read and command contract. schema 0297, after oracle 0296 and articles 0295,
separates conversation admission order from display order. existing context
ranks are copied; malformed ranks or mismatched
conversation occurrences abort conversion. no content is deleted.

the newest verified production backup (`8a67e218a`, revision 0292,
1,296,042,015 bytes, sha256
`f92a4a68df62055264e89a9bd378833c3b0208beae72e68b738c2a51d849e702`)
restores successfully. its actual upgrade to head stops at the existing 0293
refusal: published x media `8e08157a-2584-41fd-a5e0-8ffe4bb9a415` lacks
normalized source evidence. the clone remains 0292; 0297 is not reached.
[the x cutover owner](release-x-thread-imports.md) owns that repair and its
production impact preview. isolated populated 0296→0297 conversion/refusal checks
pass; they do not complete the production-backup rehearsal.

before release:

- resolve the x cutover precondition, then rehearse the actual combined head on
  the newest verified backup with any deliberately reviewed repairs. inspect
  refused rank rows and repair ownership/order deliberately; do not guess.
- retain wire 12 for the current unreleased client break (the x-thread cutover
  already bumped released wire 11 to 12). recheck the release boundary if another release lands
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
