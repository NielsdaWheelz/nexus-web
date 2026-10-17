# nexus launch click before hydration is lost

status: open
origin: 2026-10-15 library chooser integration, `55673a8b0`
area: web / nexus launch admission

the server-rendered add button accepts a click before its react handler is ready,
but nothing opens. this inherited launcher gap is separate from library selection.

evidence: `apps/web/src/components/appnav/AppNav.tsx:195–205` exposes the button
and calls `requestNexusOpen`. `apps/web/src/lib/nexus/events.ts:16–21, 51–69`
queues invoked requests until the receiver mounts;
it cannot retain a click that never reaches the caller. on a fresh local `/lectern`,
the first click at 142 ms produced no open event or dialog; the receiver-ready
value was absent. a second ordinary click at 3191 ms, with the receiver ready,
opened the dialog immediately. no page error or library request occurred.
retained [receipts](../verification/library-chooser-online-20261015/receipts.json):
`open-probe.json`, `open-load-probe.json` and `frozen-setup-red.json`. the final
unchanged frozen-creation assertions pass after explicitly awaiting the existing
`__nexusOpenReceiverReady` flag; document load alone is not a hydration guarantee.

reproduce: navigate to a fresh authenticated document and activate add as soon as
its server-rendered button appears, before hydration. slow script loading makes
the window easier to reach. the button remains visible but the first gesture is lost.

fix: give the launcher and nexus owner an explicit ready/admission contract: make
the visible control available only when its action can be admitted, or route the
early gesture through an already available ingress. reuse the existing owner;
do not add a second queue or a generic readiness framework.

acceptance: under delayed script/hydration startup, the control is either visibly
unavailable or one early activation opens add once when ready. no second click is
needed, and ordinary post-hydration launch remains unchanged.
