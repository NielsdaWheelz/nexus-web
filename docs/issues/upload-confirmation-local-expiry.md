# qualify missing bytes after an unanswered confirmation

at `1150135dc`, a real `BytesMissing` after a lost confirmation preserved uncertainty but cleared `bytes_uploaded`. local expiry then marked the attempt expired before replay; every later retry stopped locally. intake and Commands stayed unknown, while note attachment handling could discard the held file.

`apps/web/src/lib/imports/ingest.ts` now skips an unavailable byte transfer when confirmation remains unsettled and sends the original frozen confirmation. source review supports this correction; the exact missing-bytes-after-answer-loss journey remains unqualified.

resolve with a legitimate actual missing-bytes response after a lost confirmation, natural expiry, and ordinary retry retaining session, generation, guard and command until the authoritative receipt or refusal. ordinary expiry, busy recovery and direct receipt replay prove narrower paths. no source-only merge qualification or release waiver is implied.
