# opaque recovery export drops outer fields

lab 5 at `d4c6d036b` fails both schema and rich cutover cases: exported incompatible envelopes preserve their payload and recovery fields but omit `authored_branch`. artifacts are `writing-recovery-schema-cu-9fd8d-paque-export-without-replay` and the corresponding rich case.

`journal.ts`'s `envelope` reconstructs only its known header fields and payload. `refreshJournal` stores that reconstructed value in `incompatible`, which `exportWriting` serializes. unknown outer fields of an unsupported format are therefore lost before export. future format data may live outside the current payload.

validate the stable header needed for recovery presentation, then retain the complete original envelope object for opaque export. keep unsupported payloads opaque and delivery blocked. resolved when both cutover cases export every original outer field and payload without replay.

source repair: `envelope` validates the stable header and payload presence, then retains the entire original outer object, including unknown fields. unsupported payload decoders and delivery admission remain unchanged. live qualification remains pending.
