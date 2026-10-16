# release selection popup

status: pending canonical rollout
origin: 2026-10-16 selection popup implementation
area: highlight update contract / client pairing

this change requires wire revision 5: every highlight patch carries the observed
`expected_version`, text bounds also carry `unit_id`, and highlight/map responses
expose `version`. it requires no database migration. the paired build includes
the [chat controls cohort](release-chat-controls.md); do not pair its wire 4
client with this api.

the canonical release owner pairs api, web, extension and apk builds through
the existing wire and native packaging workflow, then reloads old browser tabs.
settle pending writes and preserve unsaved reader text before reloading. native
packaging remains with its existing owner; local browser/phone verification
does not authorize canonical rollout or enter the separate book release.

acceptance: the paired build performs versioned text/pdf updates and exposes
matching read versions; stale-version and wrong-unit refusals leave the
highlight unchanged. an old wire 4 client receives the existing 426 refusal.
extension and apk builds carry the same final revision.
