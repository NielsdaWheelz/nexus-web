# pane header device qualification

the pane-header-controls spec requires supported-handset touch and spoken
screen-reader checks. the owner chose browser verification with these checks
left outstanding on 2026-10-21; no handset or assistive-technology session is
available to this implementation run.

browser geometry and accessibility-tree assertions do not prove touch handling
or spoken output. qualify the final header on a supported handset and with a
screen reader: primary names and activation, passive subscribed/not-subscribed
text, menu/inspector focus return, and mobile chrome hide/reveal. close this issue
when actual device and spoken observations establish those behaviours.

contracts: `docs/modules/workspace.md` (primary header controls) and
`docs/modules/podcast.md` (subscription status).
