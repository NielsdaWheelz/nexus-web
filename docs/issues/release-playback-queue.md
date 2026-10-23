# deployed playback queue qualification

production source `400e7039e` is deployed at schema `0312`, wire `14`, paired with
signed android `0.3.6` (code `26`). the fresh `0306` backup restored and migrated
through `0312`; production preserved media, users, highlights and saved progress.
`0312` created empty device sessions without copying lectern membership.

the owner waived old unsent playback events and their recorder drain/export.
this is not an empty-lane observation or a waiver of saved server progress.
old-apk update-required behavior was observed; the new apk retained login and the
current reading chapter without clearing storage.

remaining installed-release journeys are `NOT_RUN`: paused process restore,
browser tab transfer, downloaded native continuation without the webview, and
completion delivery after reconnect. [offline shelf controls](offline-shelf-playback-controls.md)
and [video playback](persistent-video-playback.md) remain deferred.

resolve after those journeys pass or receive an explicit owner disposition.
record proof in the release pr; the [player module](../modules/player.md) owns
the permanent queue and recorder contracts.
