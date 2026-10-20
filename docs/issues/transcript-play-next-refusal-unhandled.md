# transcript play next discards a refusal

status: open; source-proven, live reproduction pending
origin: 2026-10-16 principal-actions final review
area: transcript / lectern command feedback

`apps/web/src/app/(authenticated)/media/[id]/Transcript.tsx:233–236` discards
`lecternCommands.place()` without the action runtime or a rejection handler.
`apps/web/src/lib/lectern/lectern.tsx:229-236` drops an initial modeled 4xx
refusal from the lane and rejects the caller with it. the caller can leave that
rejection unhandled and show no failure feedback. both paths are inherited from
main `7a706f63e`; the transcript file is unchanged in `e1afc1efe`.

route this producer through the canonical command/failure owner, preserving
the exact Place intent and shared uncertainty recovery. do not add a second
lectern owner or discard the rejection. this is separate from promoting
readable-row Ensure controls; playback was not requalified in this cutover.

acceptance: a real refused transcript play-next command shows mapped feedback
without an unhandled rejection; uncertain delivery retains check-placement
recovery and its original placement/revision. actual success still places once.
