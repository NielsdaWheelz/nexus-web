# every chat run keeps its whole frozen prompt forever

status: open, owner decision · area: chat storage

`chat_runs.generation_intent` holds each run's complete frozen prompt (the system
prompt, the turn's context, the whole admitted history, the turn). only the run's own
worker start reads it (`services/chat/worker.py`); a rerun assembles its own. history
grows with the path, so a chat of n turns stores O(n²) bytes of repeated history; one
turn of a long chat stores up to chat's 512 KiB input bound.

the chat re-slice kept it on purpose (coordinator ruling R3, 2026-10-19): clearing it
deletes forensic copies of what the model saw, which the owner may want for debugging,
for a saving nobody had measured.

size on the restored production backup (`8a67e218a`, 0292 data; census C9,
2026-10-19): 18 runs in 13 chats; 143,360 bytes as jsonb text (86,064 stored after
toast compression); the largest run 9,641 bytes (5,645 stored); the largest chat
18,172 bytes over 2 runs.

options for the owner: keep (today); clear it in `events.finalize` when the run ends
and null terminal runs in a migration (the column becomes nullable); or keep a digest.

resolved when: the owner has chosen, and the chosen retention is what a terminal run
holds.
