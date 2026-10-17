# release selection popup

status: pending canonical rollout
origin: 2026-10-16 selection popup implementation
area: highlight update contract / client pairing

this change requires wire revision 6: every highlight patch carries the observed
`expected_version`, text bounds also carry `unit_id`, and highlight/map responses
expose `version`. this selection change adds no migration. the paired build
includes the [chat viewer cutover](release-chat-viewer.md), with its schema 0289,
and the [chat controls cohort](release-chat-controls.md). release that combined
build under wire 6, with the existing owner applying the upstream migration.

the canonical release owner pairs api, web, extension and apk builds through
the existing wire and native packaging workflow, then reloads old browser tabs.
settle pending writes and preserve unsaved reader text before reloading. native
packaging remains with its existing owner; local browser/phone verification
does not authorize canonical rollout or enter the separate book release.

acceptance: the paired build performs versioned text/pdf updates and exposes
matching read versions; stale-version and wrong-unit refusals leave the
highlight unchanged. an old wire 5 client receives the existing 426 refusal.
extension and apk builds carry the same final revision; the api reports schema 0289.
