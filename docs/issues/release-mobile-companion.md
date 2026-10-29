# mobile companion release prerequisites

release is blocked by large-book connections rendering; its repair remains a
separate change, as approved. fresh media now defaults to connections, making
this existing cost visible on first inspector open.

evidence: final application `da19e2959`, lab
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

native core behavior passed on the paired `da19e2959` apk, android 15 with
webview `124.0.6367.219`: real keyboard-down entry, selected-tab focus, nested
hardware back and contents destination focus. release must pair the deployed web
source and rebuilt apk. downloaded-reader parity is still being qualified.
