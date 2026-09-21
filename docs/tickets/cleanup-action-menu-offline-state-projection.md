# action menus reconstruct offline metadata they never read

status: open
origin: 2026-09-21 cleanup audit, `93563d12b62af0b4f8d84c73269f051cec6555ff`
area: web resource actions

`apps/web/src/lib/actions/resourceActionRuntime.tsx:316-345` maps native
reading availability into an imitation audio availability record. it copies
byte counts, queue reasons and timestamps, and invents a content type and
failure code. its sole consumer, `resourceActions.ts:817-910`, reads only the
phase and whether removal would discard a device position.
`resourceActionEnvironment.ts:30-45` owns the redundant record, and its optional
reading field at line 58 adds an absent state although the sole runtime
producer always supplies it at `resourceActionRuntime.tsx:1547`.

this needlessly couples action presentation to the offline storage contract;
it is a reauthoring input, not evidence that current downloads fail.

prerequisite: preserve the distinct audio and reading commands, android
availability, connectivity rules, and pending-position removal confirmation.
fix: during the action-menu rewrite, read the actual owners' state or project
only the menu facts with an explicit unavailable state. delete the unused
metadata and absent-provider branch.

acceptance: one menu projection owns the download/cancel/retry/remove verb and
confirmation; no copied byte, timestamp, content-type, queue-reason, or failure
metadata remains in the action environment. manually exercise a downloaded
reading item's removal prompt when it has an unsynced device position.
