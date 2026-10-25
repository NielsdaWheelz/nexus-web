# saved reader feedback steals its paint viewport

installed c20 QA on Samsung SM-S906W/android16/WebView155 stays blank for60s.
actual layout: shell780px/documentReader638px, textWithMap/pdfScrollport0px.
the annotation layer appends a FeedbackProvider viewport with height100% as a
flex sibling, consuming the whole reading area. local file and same-WebView
PDF.js bytes/URL controls parse the unrepaired one-page file correctly.

scoped style control changes only that sibling to height:auto/flex:none:
the actual792×1023 canvas and exact quote paint within1s. evidence:
`/tmp/nexus-localfirst-pdf-layout/layout.json` and
`/tmp/nexus-localfirst-pdf-style-control/events.jsonl`.

fix moves existing FeedbackProvider around the whole100dvh main in Shelf.tsx;
ShelfReader.tsx retains annotation-only Work/Authored readiness. independent
reviews pass. fresh APK PDF annotation/reopen/reconnect proof remains required;
style control is diagnostic, not final qualification.
