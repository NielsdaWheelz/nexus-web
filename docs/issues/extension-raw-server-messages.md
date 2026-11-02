# the extension popup shows server messages verbatim

status: open · origin: 2026-11-02 import content sheet (slice 2), open point 5 · area: extension / copy

`apps/web/src/extension/nexusClient.ts:161-166` throws `String(error.message)`
for any coded refusal, and the popup prints it. those are the server's
developer messages, in its case and voice, so feedback-homes' copy floor fails
in the popup whatever the content sheet says. slice 3 lane c owns the file's
copy (orchestrator ruling 17), but no lane maps refusal codes to words there.

impact: an import refused through the extension reads as a server log line.

resolved when: the popup words each code it can meet from the imports copy
owner (`apps/web/src/lib/imports/copy.ts`), and shows no server message.
