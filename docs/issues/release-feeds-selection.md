# feed and selection release acceptance

production `dbaa832ea` reached schema `0341` and wire `21` on 2026-11-12.
the newest backup passed the complete `0337`→`0341` rehearsal; the canonical
stopped-writer release took and verified its own backup. feed controls now use
`FEED_REFRESH_DUE_SCHEDULE_SECONDS` and `FEED_REFRESH_DUE_LIMIT`; the retired
podcast keys are removed. server migration and hosted pairing are complete.

remaining: observe resumed finite work, independent head refresh, durable opml
continuation and the next 07:00 edition in the account's calendar zone. source
coverage and article availability remain separate facts.

qualify the paired installed clients and catalogue format `4`. old snapshots
need an online rebuild; retain local authored data, downloads and account binding.
old wire `20` is refused. deployment alone does not establish installed browsing
or reconnect behavior.

contracts live in [feeds](../modules/feeds.md),
[selections](../modules/suggestions.md) and
[the saved catalogue](../modules/offline-catalog.md). recovery requires compatible
paired assets and the actual durable-format contract, never an old reader against
the migrated schema.

resolve when these deployed work, edition and installed-client observations are
recorded in the release pr.
