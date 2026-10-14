# list cursor codecs diverge

problem: every collection list moved onto one keyset plan and cursor codec
(`services/collection_keyset.py`, architecture §8.12), but other cursored reads
still mint their own cursors:

- `services/search/query.py` `encode_cursor`/`decode_cursor`: an offset cursor
  over a json payload, also used by contributor search.
- `services/media.py` `_encode_cursor`/`_decode_cursor`: `(updated_at, id)`.
- `services/resource_graph/connections.py`: a plain `"<created_at iso>|<edge id>"`.
- `services/consumption/stats.py` `_next_cursor`/`_decode`.
- `services/tools/assistant_writes.py`: a bare row id `before`.
- web `lib/api/useCursorPagination.ts` and `lib/api/pagePrefix.ts` are two more
  client page owners beside `useServerList`.

envelopes: `{items, next_cursor}` for the collection lists and, since the
libraries reauthor, the library index, entries and destinations (web and
extension); library members and invitations still answer
`{data: [...], page: {next_cursor}}` until the membership slice.

impact: several codecs and envelopes for one paging idea.

resolved when: one cursor codec and one envelope across the python list routes
and one web list hook, moved one owner at a time with its slice.
