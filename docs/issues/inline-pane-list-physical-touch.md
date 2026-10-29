# physical touch qualification

the inline pane list still needs human touch qualification on a physical device.
browser-protocol touch and an android emulator can establish gesture dispatch,
order and cancellation, but not comfortable hold timing or reliable thumb use.

the interaction is owned by `apps/web/src/components/nexus/NexusPaneList.tsx`: whole-body drag,
250ms hold, 8px tolerance and an independent 48px mobile close target. no personal
phone or browser was used for this change.

resolve by checking native scrolling before hold, first/last placement through
overflow, outside-release cancellation and the next ordinary tap on a physical
device. confirm the close target stays independent and the hold is comfortable.
