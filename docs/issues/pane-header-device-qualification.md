# pane header spoken qualification

the pane-header controls have no spoken screen-reader check; browser
accessibility-tree assertions do not prove spoken output. no assistive-technology
session was available to the implementation run (2026-10-21).

with a screen reader, check the final header's primary names and activation,
passive subscribed/not-subscribed text, and menu/inspector focus return. close
this issue when actual spoken observations establish those behaviours.

contracts: `docs/modules/workspace.md` (primary header controls) and
`docs/modules/podcast.md` (subscription status).
