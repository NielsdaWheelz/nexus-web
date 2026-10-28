# podcast http audio blocked by csp

problem: a catalogue episode offers playback although its supplied http audio
url is forbidden by the browser's media policy. the player briefly offers pause,
then returns to resume at 0:00; no audio request is sent.

evidence: live lab `20261028-151602-2738c6624935`, episode “Dozens killed in train
crash in Spain”. chromium reports that
`http://open.live.bbc.co.uk/mediaselector/6/redir/version/2.0/mediaset/audio-nondrm-download-rss-low/proto/http/vpid/p0pk3gws.mp3`
violates `media-src 'self' https:`. descriptor loading and All membership succeeded.
`apps/web/src/lib/security/csp.ts:18` owns that policy;
`python/nexus/services/podcasts/ingest.py:257` retains safe http enclosure urls as
`external_playback_url`. this precedes the menu presentation change.

resolution: align playback capability and source delivery with the web media
policy. resolve a genuinely supported secure source or expose the actual
unavailability before offering playback; do not guess an https rewrite or loosen
csp. preserve the native delivery contract. qualify the affected real feed and
an existing https feed through browser playback and user-visible failure handling.

the menu change qualifies playback using a supported real https episode;
repairing feed delivery is separate scope.
