# message deletion confirmation omits its descendants

status: open
origin: 2026-10-16 chat viewer source audit
area: web / chat / destructive-action copy

`apps/web/src/lib/actions/catalog.ts:288-295` asks only whether to delete this
message. the operation recursively gathers and deletes every descendant
(`python/nexus/services/chat/conversations.py:212-225,259`) and deletes the
conversation when no messages remain (`:261-270`).

impact: the confirmation understates the irreversible operation's scope. this
was verified from source without invoking deletion.

prerequisites: none. have the owned confirmation explain that the message and
all replies/forks below it will be deleted. disclose that an empty chat is also
removed. counts are optional; do not require a new preflight read merely to
write truthful copy.

acceptance: deleting an early user or assistant message clearly warns about
its descendants before confirmation; deleting the last remaining subtree
communicates the conversation consequence. retain the existing authorization
and cancellation behavior.
