# a passage reference in the librarian opens its source without revealing it

status: open · found 2026-11-12 by reading at `125f1ab87`; not run · area: web / librarian references, reader arrival

a `passage_anchor:<id>` reference has no locator, so the figure's link sends a
`live_reference` target with `locator: null`
(`apps/web/src/components/chat/LiveReference.tsx:23`). the server answers a whole
source for any reference without a locator
(`python/nexus/services/resource_items/evidence.py:2066-2069`), and the reader only
focuses. the passage's own route, `/media/<id>#passage-<id>`, reveals it, but the
entry overrides that href. a note-owned passage keeps `passage_anchor:` as its
activation ref and probably fails the same-owner check in
`apps/web/src/lib/reader/sourceArrival.ts:283-289`.

impact: following an attached passage lands at the top of its source; for a
note-owned one, probably on an error. rare today: passages reach the librarian only
through the action menu.

resolved when following a passage reference from the librarian reveals the passage.
