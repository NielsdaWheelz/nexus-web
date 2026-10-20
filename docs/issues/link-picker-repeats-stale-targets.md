# a link composer shows pre-pick targets when the same query is typed again

status: open; reproduced in the refs harness, cause inferred · origin: resource references re-slice port onto main, 2026-10-19 · area: resource insertion (web)

after picking a target from a row's "add item" composer ("@heathland" → Heathland Diary), typing
the same "@heathland" again in the same composer lists Heathland Diary without "already linked",
although `POST /resource-items/targets/search` for that source now returns its `existing_link_id`.
afaict `useLinkTargets` keys its list by `[query, source, exclude]` with a constant `stale`, so the
repeated query reuses the pre-pick page and sends no second search; nothing invalidates it when a
link commits. the refs harness journey `search/L1.link-picker-from-search-row` records the number
of target searches sent after the pick (`refs/harness/state/port-*.txt`). the client path is
main's (#683), unchanged by the re-slice.

impact: a person can pick an already-linked target again; the server answers the existing link
("already linked"), so no duplicate is made, but the list misstates the state.

resolved when: the journey passes (it is XFAIL only while no search follows the pick).
