# mobile companion release prerequisites

release is blocked by large-book connections rendering.
the rendering repair remains a separate change, as approved.
fresh media now defaults to connections, making this existing cost visible on
first inspector open.

evidence: application `da19e2959`, lab
`20261028-190822-8f9c635ed420`. a real epub admitted through the existing parser
and publication owners has 100 chapters, 10,000 references, 20,000 apparatus
items and 1,640,401 canonical characters. parsing took 9.29 seconds. connections
exceeded the ordinary 15-second readiness deadline; the stage took 18.33 seconds
including activation. a subsequent three-second dom readback timed out, so its
mounted node count is unknown. a smaller 6,000-reference book on `d82c74ebe`
mounted 234,643 nodes and took 14.19 seconds to open connections; that does not
clear the previously reported 401,951-node failure.

see [the rendering issue](large-reader-connections-blocks-ui.md). resolve it and
qualify representative first-open, filtering, source reveal/return and dismissal
under ordinary action deadlines. preserve row identity, disclosure, focus and
visit memory. increasing deadlines or accepting a smaller corpus is not a fix.

native behavior passed on `26507b6e7`, lab
`20261028-201503-b4d99d9ffe6a`, paired apk sha256
`94c792dd0183ce5c939fbccb868880b5124c2706b4aa3b5e812d0848684e8247`:
real keyboard-down entry, selected-tab focus, nested hardware back and contents
destination focus, plus a real download, restart, offline open and ordinary
touch navigation to the last of 24 contents entries. the owned android 15
emulator used official chromium webview
`159.0.8130.0`, snapshot `1729791`, above the documented viewport floor; this is
not google stable-channel evidence. release must pair the deployed web source
and rebuilt apk.

main `f0b23ce0d` changes header geometry and native viewport inset ownership.
the merged source needs fresh header/native geometry qualification before
release; the paired-apk proof above applies to its recorded source only.

earlier download-readiness misses remain a
[lab repeatability follow-up](native-lab-download-readiness.md); the final
ordinary downloaded-reader journey passed without a debugger or forced input.
