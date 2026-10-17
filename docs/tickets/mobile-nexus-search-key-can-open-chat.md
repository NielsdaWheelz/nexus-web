# mobile nexus search key can open chat

status: open; source-confirmed, device reproduction pending.
origin: 2026-10-16 mobile command palette design review.
area: nexus / query submission.

problem: `apps/web/src/components/switchboard/SwitchboardTask.tsx:97` advertises
`enterKeyHint="search"`, but lines 116–118 activate the selected row.
`components/nexus/useNexusController.ts:123–124` defaults selection to the first
row. when ordinary text has no results, `lib/nexus/rows.ts:429–431` starts with
query actions, whose first row is ask nexus (lines 394–395). web paths are
relative to `apps/web/src`.

impact: the search key can navigate to chat with the query when the user has
not selected an ask action. this ticket does not assert a chat run is submitted.

reproduce: enter ordinary unmatched text, leave selection untouched, then use
the soft keyboard search key. inspect the target accepted by the controller.
the path is source-confirmed; no physical keyboard run was made in this review.

prerequisites: specify submission for ordinary retrieval, explicit commands and
deliberate hardware-key selection. proposed fix: ordinary mobile submit opens
the full search with the same query; explicit row activation remains a separate
intent. do not infer user selection from the automatically highlighted row.

acceptance: matched, unmatched and still-pending ordinary queries submit search;
explicit ask requires its own deliberate activation; hardware navigation,
modified keys and composition obey the documented selection contract.
