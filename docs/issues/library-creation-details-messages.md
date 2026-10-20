# library creation and placement hide four messages behind "details"

status: open (owner content question)
origin: 2026-10-19 libraries + ordering re-slice, coordinator review R8
area: libraries / feedback content

`FeedbackNotice` shows a notice's title and puts its `message` behind a
"details" toggle (`components/feedback/Feedback.tsx`). four library notices
carry the sentence a reader needs in that hidden message (#629/#633 behaviour,
conserved unchanged by the re-slice):

- creating library… → "you can close this dialog. creation will continue."
  (`app/(authenticated)/libraries/useLibraryCreation.tsx:176`)
- creation not confirmed → "this library may already exist. retry before
  creating another library." (`useLibraryCreation.tsx:37`)
- change not confirmed (a chooser row) → "check the current membership before
  changing it again" (`lib/libraries/placementController.tsx:182`)
- replace filed episodes? → "<library> already files episodes from this show.
  Adding the show replaces those entries; the episodes stay in All."
  (`components/libraries/PlacementOverlay.tsx:40`)

impact: a reader acts on the title alone (closing a dialog they think would
cancel, retrying under a new name, replacing without knowing the episodes stay).

decision owed: for each, keep it behind details, or move the sentence into the
title or a visible line.

resolved when: the owner has ruled on each and the copy matches the ruling.
