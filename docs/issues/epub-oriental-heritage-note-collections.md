# oriental heritage note collections lack complete body proof

the audited *our oriental heritage* epub (sha256 begins `27e7a542`)
has 3,304 verified notes that the importer leaves as authored links.
3,293 are numbered entries in the two notes collections and 11 have roman
markers. `OEBPS/text00052.html` and `OEBPS/text00054.html` sit on either side
of a separate bibliography. both have independently headed groups and
printed entries without their own return. the private `pair-audit/durant.json`
records every source interval, including the one at
`text00052.html#introen1`.

reproduce by resolving the original note destinations and running
`nexus epub-repair preview <media-id> --projection apparatus`.
acceptance requires an independently proved interval for each promoted
body on upload and retained repair, including any continuation, with
the unrelated bibliography and the next printed entry outside that body.
