# after a structure edit, a page over 100 items briefly loses its loaded rows past 100

status: open · origin: notes re-slice design (L12) and harness (outline/O35), 2026-10-21;
fixed only by the dropped web engine (P2) · area: notes outline
(`lib/notes/useOutlineSession.ts`)

a structure command's reply carries one outline page per touched lane, the first 100
items. the tab adopts it over its loaded view, so on a page with more than 100 loaded rows
everything past 100 disappears until the prefix refetch brings it back.

impact: rows past 100 vanish and return after every insert, split, move or join on a long
page. no data is lost; what a row being edited past 100 does meanwhile is unmeasured.

evidence (main `c0063b28e`):
- `python/nexus/services/outline.py:105-107` (`read`, `limit: int = 100`) and `:451-452`:
  the reply reads each outlined lane with the default limit.
- `apps/web/src/lib/notes/useOutlineSession.ts:286-298` (`receive`) adopts reply outlines;
  `:238-250` (`adopt`) replaces the graph's outline whenever the reply's `links_version` is
  not older, whatever the loaded length.
- outline/O35 is an xfail on main and on P1 (#734): with 151 rows, rows past the first
  hundred vanish after the reply.

repro: a page with 151 notes, all loaded ("show more"); press Enter at the end of any row;
watch rows 101-151.

starting point: P2 (`88acbbf1e`) never let a partial reply truncate a longer loaded view.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: outline/O35 passes (151 rows stay through the reply).
