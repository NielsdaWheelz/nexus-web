# local query subscriptions multiply serialized native reads

resource rows, their menus and live documents each subscribe to local resource
queries. `useAuthoredQuery` also starts an explicit query after subscribing;
both browser and native subscriptions already perform their own initial query.
each corpus commit refreshes every subscription. on native, these reads share
one serial queue, and each logical call has at least four sequential bridge
frames (`begin`, `chunk`, `invoke`, `read`).

`lib/authored/native.ts` calls `changed(true)` inside commit before returning its
receipt. that queues the existing subscribers' reads before a newly mounted
note's `runtime.loadDocument` can read its canonical state. document refresh
itself queries the projection and then reads state. `LocalOutline.focusResource`
may add binding, link-state and resource reads before opening the document.
there is no fixed four-second delay in these owners; the 250 ms native hints
loop wakes network sync, not local document hydration.

native15 measured one tiny-corpus save-to-render at **4573 ms**, with canonical
commit/body confirmed. native14's five-second mutable-row wait raced that
hydration. this is functional evidence, not proof that subscription fanout
caused the delay, and not a 100,000-block capacity result.

measure at the responsible owners before changing architecture: commit ack;
`changed(true)` subscriber count; native queue enqueue/start/end and bridge-frame
durations; adjacency receipt; document state-read start/end; hydrate/history
attachment; editor binding and first paint. preserve the existing target budgets.
resolved when target-device capacity measurements attribute the delay and meet
those budgets, or a measured narrow change removes the redundant work while
preserving local menu availability and canonical document identity.
