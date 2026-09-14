# the artwork over-limit refusal cannot be told from the absent-length refusal

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native playback artwork

## what is wrong

`apps/android/app/src/main/java/app/nexus/android/playback/NexusOriginClient.kt:195-198`
uses one `require(declared in 1..MAX_ARTWORK_ENCODED_BYTES)` for two distinct
conditions: `Content-Length` absent (`contentLength() == -1`) and an advertised
size over the encoded bound. both produce the same message, which is the only
observable the proof at
`apps/android/app/src/test/java/app/nexus/android/playback/NexusOriginClientTest.kt:45,49`
can key on — so the test cannot distinguish the two and would enshrine the
ambiguity if changed alone.

## prerequisites

the production predicate must be split first; changing only the test leaves a
knowingly red assertion or a weaker oracle.

## proposed fix

split into two requires with distinct messages ("artwork response declared no
length" and "artwork response exceeds the encoded bound"), then key each test
case on its own message.

## acceptance

the absent-length case and the over-limit case fail with different messages, each
asserted by its own case.
