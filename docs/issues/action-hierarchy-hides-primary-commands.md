# shared action presentation hides primary commands

status: open design follow-up
origin: 2026-10-14 menu design audit; source rechecked 2026-10-16
area: web / pane chrome / collection actions

`docs/modules/workspace.md:290-315` mandates one more menu and permits only
the inspector as a promoted action. primary tasks such as new chat
(`apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx:61-67`)
are consequently menu-only.
this is a product hierarchy follow-up, not a broken click handler. the owner
clarified on 2026-10-14 that the menu and its contents are wanted; the main
complaint concerns the trigger's appearance. selective promotion is welcome.

prerequisite: identify the few primary commands worth promoting. retain the
existing menu and contents; no general scope split or replacement interaction
is required. direct controls and menus
must project the same descriptors, availability, confirmations and runtime.
existing `apps/web/src/components/ui/ResourceRow.tsx:126-132` slots and
`apps/web/src/components/collections/LecternAddControl.tsx` already demonstrate this.

2026-10-16 proposal: publish one optional principal link or command independently
of query availability; render it in the pane's existing controls band at every
width. retain a visible label and allow wrapping before sacrificing identity.
the cost is control-band height in narrow panes. query content is currently
opaque jsx, so sharing a filter row requires deliberate composition, not styling
another module's internals. creation must remain reachable when a query or list
is unavailable. candidates: new chat, new library, add content and browse;
lectern needs no invented header task. existing menu entries stay; new library
has no established menu entry to preserve. the creation plan's identity-bar
placement must be reconciled before implementation.

baseline corrections: pane close/minimize already live in `WorkspacePaneStrip`;
filter/sort already have controls; `OverflowMenuButton` already has its icon and
state paint. resource menus now fetch on open, with no snapshot reconciliation
gate. the remaining latency and per-row read concern is
[tracked separately](resource-action-reads-wait-before-send.md). a direct lectern
add must preserve additive intent and pending recovery; membership is a domain
fact, not a checkbox-state inference. its presence never requires promoting
removal into the same control.

acceptance: the agreed primary commands are directly available. narrow
panes, keyboard and touch retain every command without hover-only access,
moving titles or a universal wall of row buttons. no new backend action policy
or command registry. update the workspace and visual contracts with the change.
