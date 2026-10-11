# list cursor codecs diverge

status: open · origin: 2026-10-10 collection-revision cut (cleanup/collection-keyset-continuations, design Q1) · area: lists / pagination

the cut moved every keyset list onto one plan + one cursor codec
(`python/nexus/services/collection_keyset.py`, architecture §8.12). five other
cursored reads still mint their own cursors, never paged by revision and have
their own owners, so they were left as they are:

- `services/search/query.py:168-198` `encode_cursor`/`decode_cursor`: an offset
  cursor over a json payload, also used by contributor search.
- `services/media.py:815-831` `_encode_cursor`/`_decode_cursor`: `(updated_at, id)`.
- `services/resource_graph/connections.py:43,81-95`: a plain
  `"<created_at iso>|<edge id>"` string.
- `services/consumption/stats.py:627-650` `_next_cursor`/`_decode`.
- `services/tools/assistant_writes.py` (account history, model tools slice): a
  bare row id `before`, resolved to `(created_at, id)`.
- web `lib/api/useCursorPagination.ts` (browse preview, stats, link target
  dialog, connections) and `lib/api/pagePrefix.ts` (imports, assistant writes)
  are two more client page owners beside `useServerList`.

the page envelopes also keep three spellings: `data.nextCursor` (the six
families), `page.nextCursor` (library governance) and snake `next_cursor`
(destinations, imports, assistant writes).

proposed fix: move each onto `keyset_page` (search's offset cursor needs a total
order first) and one envelope, and `useCursorPagination`'s users onto
`useServerList`, one owner at a time with its slice.

acceptance: one cursor codec and one envelope across the python list routes; one
web list hook.
