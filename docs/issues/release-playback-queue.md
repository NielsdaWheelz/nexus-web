# playback queue release

release requirements: rehearse migration `0312_playback_sessions` on the newest
production backup, then deploy it after `0311_chapter_end_provenance`. it creates
an empty browser-device session table; lectern membership is not converted into
playback queues. ship wire
`14` with its paired android build: the api, bridge and native persistence cut
over together. production still accepts wire `13`: the health probe with `13`
passes the wire check to `403 E_INTERNAL_ONLY`, while `14` gets `426 E_WIRE_MISMATCH`.
queue, podcast-library and transcript changes share the pending bump to `14`.
no old/new compatibility period.

before deploying either the new api/wire or apk, bring the old app online,
pause playback, drain pending listening/end writes and verify the lane is empty.
stop the old service and keep playback stopped until the paired installation finishes.
retain a recovery copy of `player/listening.json` and remove that retired file
only after that proof. if pending writes cannot drain, block the cutover and
repair them; never discard
unacknowledged completion. the new app reads only
`player/accounts/<account-id>.json`.

after the paired deployment, confirm paused restore, browser tab transfer,
downloaded native continuation without the webview and completion delivery after
reconnect. [offline shelf controls](offline-shelf-playback-controls.md) and
[video playback](persistent-video-playback.md) remain deferred. delete this
record once the migration, recorder drain, paired deployment and those journeys
are confirmed; record proof in the release pr.
