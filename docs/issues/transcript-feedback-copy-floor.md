# transcript feedback exposes transport vocabulary

`lib/podcasts/episodeCommands.tsx:39,178` uses `request` in the refused and
unknown transcript facts. feedback's content floor expressly excludes it.
the command owner freezes the serialized forecast and knows whether the
transcription command was refused or its outcome remains unknown.

name transcription directly: `couldn’t start transcription for “<title>”.`
and `not sure transcription for “<title>” started.`. keep the canonical unknown
reason. resolved when both facts name that operation without transport terms,
with every attached cause independently proved by its actual error owner.

the same owner at line 99 also says `the eligible episodes changed.` for
generic `E_RESOURCE_CONFLICT` and `E_CONFLICT`. the actual batch endpoint
(`python/nexus/routers/transcription.py:114-117`) proves changed selection only
with `E_SELECTION_CHANGED`; `api/edge.py:94-98` emits resource conflict for a
busy database transaction. keep the cause only for the typed selection result;
generic conflicts must use the shared refusal without a guessed cause.
