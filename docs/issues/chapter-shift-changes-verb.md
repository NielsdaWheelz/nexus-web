# chapter shift changes verb

problem: a player chapter's plain activation seeks playback; shifted activation
opens the transcript at that chapter in a new pane. shift therefore changes the
verb, not the placement. the classifier's contract is that a gesture "changes
placement, never the destination or the underlying write"
(`apps/web/src/lib/ui/targetActivation.ts:3`). the chapter's one-item "open in
new pane" menu is the only visible route to reading a chapter's transcript, and
its label names a placement for what is really a different destination.

impact: "open the transcript here" is undiscoverable as a verb and mislabelled
as a placement variant. it is the one surviving one-item menu labelled as a
fork, which `docs/modules/workspace.md` § target activation rule 2 forbids;
deleting it under that rule would strand the transcript behind a gesture that
contradicts the shared gesture law.

evidence at `4a5b1c710`: `apps/web/src/components/player/PlayerPlaybackControls.tsx:186-207`
(default intent calls `commands.seekTo`; `new_pane` calls `openAsyncResult` for
the transcript), the adjacent chapter `ActionMenu` (`:214-243`) with its single
`OpenInPane` option, and `docs/modules/reader-implementation.md` § flows,
**find.** (“player chapter menus expose “open in new pane””).
`docs/modules/player.md` documents no chapter shift behavior.

proposed fix: name the verb. offer "read transcript from here" (or similar) as
the chapter's own command; shift on that command forks it. the chapter row only
seeks, shifted or not. document the chapter contract in `docs/modules/player.md`.

resolved when plain and shifted chapter activation differ only in placement,
the transcript route has its own visible name, and the player doc states both.
