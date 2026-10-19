# chat draft storage conflicts with owner rules

status: open, narrowed by the owner 2026-10-18: an unsent draft (text, selection) is a per-viewer convenience browser storage may hold (AGENTS.md). left: whether frozen send requests for an uncertain send stay in browser storage (a resend reuses the client-minted run id, so no ledger is involved) and the module contract update; the chat web re-slice decides.
origin: 2026-10-16 chat input specification
area: chat / draft persistence

at `origin/main` `ff5712884`, `apps/web/src/lib/chat/drafts.ts:20-22,95-143`
stores authored text, selection and frozen send requests in session storage.
`AGENTS.md` now permits only viewer conveniences there, never app data;
`docs/modules/chat.md:35-40` still specifies the older persistence contract.
the implementation and binding rule therefore disagree about who owns drafts
and recovery across reload. this change must not silently erase text or an
unresolved command.

the chat control work adds no persisted state: unfinished provider/model/mode
choices stay in memory; only a completed selection reaches the existing draft
owner. the user accepted losing unfinished selection changes on reload or
conversation exit. redesigning draft persistence remains separate work.

resolve by choosing one draft/recovery owner under the current write rules,
updating the module contract and cutting over actual drafts explicitly.
acceptance: no application data remains in browser storage; unsent text and
uncertain sends have an explicit, verified lifecycle without a replay ledger
or compatibility reader.
