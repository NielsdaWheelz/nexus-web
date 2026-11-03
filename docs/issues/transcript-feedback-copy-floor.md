# transcript feedback exposes transport vocabulary

`lib/podcasts/episodeCommands.tsx:39,178` uses `request` in the refused and
unknown transcript facts. feedback's content floor expressly excludes it.
the command owner freezes the serialized forecast and knows whether the
transcription command was refused or its outcome remains unknown.

name transcription directly: `couldn’t start transcription for “<title>”.`
and `not sure transcription for “<title>” started.`. keep the canonical unknown
reason. resolved when both facts name that operation without transport terms,
with every attached cause independently proved by its actual error owner.
