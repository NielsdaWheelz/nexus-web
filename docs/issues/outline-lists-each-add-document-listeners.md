# every outline session adds its own three document listeners

status: open · origin: notes re-slice spec (L10), 2026-10-21; fixed only by the dropped web
engine (P2) · area: resource items (`components/resources/ResourceOutlineList.tsx`)

each outline session scope installs capture listeners for `pointerdown`, `keydown` and
`focusin` on `document` to stamp its interaction clock. every resource list mounted without
an enclosing session (search results, chat context, connections, evidence, collection rows)
creates its own session, so every click, key and focus change in the tab runs one handler
per mounted list.

impact: low. the cost grows with the number of mounted lists, not with what the person
touches; no behaviour is wrong. measured nowhere (idk whether it is visible on a phone with
many panes).

evidence (main `c0063b28e`):
- `components/resources/ResourceOutlineList.tsx:55-82` (`ObservedOutlineSession`) adds and
  removes the three listeners per session scope.
- `components/resources/ResourceOutlineList.tsx:183-194` (`StandaloneList`) creates a session
  for each list without one.

starting point: P2 (`88acbbf1e`) installed one tab-wide interaction clock once (three
listeners per tab); a session per standalone list stayed, since its disclosures edit.

the owner's durable-writing work may supersede this; recheck after it merges.

resolved when: the tab has three such listeners however many lists are mounted, and focus
after an await still moves only when no interaction happened since.
