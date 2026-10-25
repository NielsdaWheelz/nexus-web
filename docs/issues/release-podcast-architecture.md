# release podcast catalogue and library architecture

status: local implementation and acceptance complete; deployment pending. contracts live in
[the podcast module](../modules/podcast.md), [libraries](../modules/library.md)
and [read authority](../modules/auth.md).

preflight actual deployed source, stopped writers, migration ancestry and backup
through the existing deployment owner. apply 0318 after 0317; it repairs every
active-rule membership hole and retires all canonical-episode removal markers.
old managed removals without rules stay absent; previously suppressed read-only
shared contributions can reappear. canonical ids, aliases, authored work,
transcripts, listening, work identities and standalone finite exclusions survive.
affected library/account guards and contributor search documents refresh.
unconvertible identity/teardown rows refuse with identified rows for live repair.
old annotations already deleted require separate backup recovery. downgrade
requires the verified backup; migration performs no feed/provider work.

pair api, web and android at wire 17: the search release shipped wire 16 and
schema 0317 on 2026-10-25 (`3d81ef45ef28f637a4de07c66ab172bbab9e22c2`). this is
the first breaking bump after that release. recheck the actual release state
before adding another bump. do not restore old resolve routes, count fields, action variants or snapshot readers.
existing native wire validation retires incompatible snapshots; preserve its
size limits and atomic replacement. package the matching native assets and wire.

local qualification covers catalogue/tools without saving, protected memberships,
exact bulk destinations, keep/remove lifetimes, guarded uncertainty, batch state/undo
and the 0317→0318 data cutover. real publisher history and an explicit unsaved
transcript passed. android api 34 passed native saved-catalogue validation, cold
offline browsing with blocked writes, coherent live reconnect and restored actions.
web and native checks use wire 17; static checks pass. temporary scenarios are
removed after independent acceptance; the pr holds detailed proof.

release still requires the stopped-writer backup, paired api/web/native activation,
actual 0318/wire 17 verification and post-cutover checks on the deployed data.
resolve this issue only after those deployment steps.
