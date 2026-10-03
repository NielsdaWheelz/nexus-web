# malformed deepgram results escape transcription failure mapping

status: open · origin: 2026-10-03 walknote event-loop repair verification · area: transcription provider adapter

`DeepgramClient._listen` catches invalid json and request failures, but calls `_extract_segments` after its `try` block. a 200 provider reply with a malformed `results` value raises `ValueError`; the authenticated walknote route returns `E_INTERNAL` (500) instead of a transcription failure. the same adapter also serves podcast transcription workers, whose impact needs checking.

evidence: the task-local provider returned `{"results": []}` to an actual walknote upload on both sides of the event-loop repair. both returned `E_INTERNAL` (500); normal success, http error, and empty transcript mappings remained stable. the source change intentionally preserves this pre-existing contract.
source-only inspection also finds `results.utterances=7` would raise `TypeError` during unguarded iteration; that shape was not exercised against the live route.

resolve by defining the adapter's malformed successful-response outcome and containing extraction errors at that owner. prove the chosen mapping through the walknote route and relevant podcast worker path while preserving valid transcript extraction.
