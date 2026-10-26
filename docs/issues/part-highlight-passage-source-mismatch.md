# part highlight capture gives its passage a different locator owner

source inspection at `eb5c9ebf6`; no live reproduction yet.

`apps/web/src/lib/documentReader/model.ts:257` maps a part's `mediaId` to
`provenance.source_media_id`. `annotations.ts:66` therefore selects the canonical
source owner, and `annotations.ts:144` writes that id into the captured locator.
but `annotations.ts:148` gives the passage the route part id. `boundCapture`
copies that locator into the passage capture (`annotations.ts:348`).

when the part id differs from its source id, this disagrees with
`node/authored/src/validate.ts:40`, reached for passage captures at line 123:
`Locator media disagrees with immutable source`. a text highlight created on a
part can therefore fail its atomic local commit, including its attached note.

the producer intentionally keys the passage to its semantic slice (the comment
above `Capture.passage` states this). its locator correctly names the physical
publication owner. the validator conflates those identities. separate locator
grammar from canonical-owner equality: highlights retain exact owner checks;
media passages retain their semantic part and must prove its relationship before
using geometry. preserve note identity checks and validate physical media uuids.

resolved when actual part-reader highlight/note creation commits atomically and
its passage reopens offline on an authorized containing reading, including the
distinct part/source ids. no producer rewrite or capture mutation is required.
