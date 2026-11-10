# feed and selection release

release obligation for [feeds](../modules/feeds.md),
[selections](../modules/suggestions.md) and
[the saved catalogue](../modules/offline-catalog.md). the local implementation
is not a deployed release.

before merge, rehearse this migration on the newest production backup. the local
restored pre-change application fixture proves the exercised retained-state
contracts; it does not qualify production rows that fixture did not contain.

stop writers and take the deployment controller's verified backup before applying
`0338_feeds_selection` after `0337`. it rehomes podcast lifecycle identities,
rules, finite operations, aliases and queued work; preserves media, authored work
and playback settings; adds feed provenance and account discovery; and rejects
unconvertible identity/work state. pre-cutover discovery remains an unknown
baseline. old episode `canonical_source_url` copies of retrieval urls are cleared;
new observations expose actual episode permalinks. retrieval credentials remain
behind source authority.
retained native x article extent stays unknown or becomes excerpt from its existing
incomplete source fact; migration preserves body bytes and grants no new source authority.
saved library-add tool results move their source and operation keys to the shared
feed contract. recorded arguments and unrelated receipt facts remain unchanged;
the matched pre-change backup retains their original representation. api and tools
both return `operation`, with no `import`/`import_` serialization aliases.

pair api, workers, web and android with wire `21` and catalogue format `4`.
old snapshots are explicitly incompatible; replacing them must retain local
authored data and installed account binding. do not run old code against the new
schema. verify the actual release's wire boundary before publishing: one bump
between releases, including any other breaking changes already merged.

rename deployment `PODCAST_REFRESH_DUE_SCHEDULE_SECONDS` and
`PODCAST_REFRESH_DUE_LIMIT` to `FEED_REFRESH_DUE_SCHEDULE_SECONDS` and
`FEED_REFRESH_DUE_LIMIT`; remove the old keys before starting paired writers.
these controls now govern all subscribed sources.

after exact-head verification, inspect resumed finite work, independent head
refresh, durable opml continuation and the next 07:00 edition in the account's
calendar zone. source coverage and article availability are separate facts.
recovery means an owner repair or coordinated restoration of the stopped system;
there is no compatibility reader or automatic rollback over migrated data.

resolved after hosted checks, coordinated deployed cutover and installed-client
observations are independently recorded in the implementation pr/release.
local qualification does not establish those stages. this record authorizes no
deployment.
