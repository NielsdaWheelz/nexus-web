# source menu can retire before its first command

status: intermittent initial-publication concern; cause unconfirmed.

on 2026-10-20, production lab run `20261020-081748-d4f094e080af`
at `46fea7db9` displayed the message menu, then announced “actions changed.
reopen to see current options.” before a message command ran. run
`20261020-082843-87bb4b2a0107` at `8a1f08d27` similarly retired the mobile
sheet before activation. neither executed a command or changed the destination.

citation integration run `20261020-104932-1cce2f7ba675` reproduced retirement
with a synthetic mouse click in a 390px touch context after the tour was removed.
that narrows the retained reproduction to the message-menu publication path;
it does not establish the changing value or a native-tap failure.

the original command was the now-removed source tour. qualify the retained
message menu during initial page layout and desktop-to-narrow entry; capture
which published value changes before selecting a retained command. the composer
may still be resolving model availability. later desktop source reuse and
three measured repetitions passed with unchanged trigger/menu/row geometry;
those passes do not explain the earlier retirement.

resolved when the invalidating meaning or geometry value is captured and shown
to be an expected change, or its responsible publication fault is repaired and
the same live journey passes. keep the frozen-menu guard; do not add retries,
delays or speculative lifecycle machinery.

2026-10-21 podcast review isolated a separate native-200% fault at `8e12c1878`:
subpixel compositor noise crossed rounded geometry buckets. `ActionMenu` now
compares raw coordinates with its frozen snapshot; that zoom journey and real
resize dismissal passed at `b1696e6e2`. this does not classify the message cases.

at `b1696e6e2`, a desktop podcast `Subscribe` row also retired before activation
after successful facts/detail reads. its trace lacks raw geometry at retirement;
a later canonical-detail probe passed with stable public meaning and geometry.
evidence: private lab `20261021-170451-47c3ed1be881`, failed acquisition case
`trace.zip` and `desktop-subscribe-remaining-probe-trace.zip`. cause remains open.

2026-10-25 installed android interface also retired an initial source-row menu
before `play from here`. task emulator `emulator-5584`, android15/webview124,
paired dirty source at `7aba511d9`, lab `20261025-120709-038a7a8f5b38`.
cdp mouse clicks on newly seeded libraries' alpha/delta triggers returned, then
no menu/dialog remained; a second explicit click opened the real action sheet.
this establishes an installed-interface reproduction, not a physical-touch
failure or the invalidating value. exact-list scoping did not remove every
occurrence. private evidence: `artifacts/native-feedback/failure-dom.txt`,
`failure.png`, and `.nexus-local/player-feedback-native/green-native*.log`.
player-feedback qualification uses the existing inline playback control instead;
this source-menu concern remains open outside that change.
