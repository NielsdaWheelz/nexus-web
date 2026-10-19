# the existing-chat picker shows only 25 chats

status: open; owner decision · origin: 2026-10-04 chat rewrite (design §9 cut 4) · area: chat / reader quote

"Ask in existing chat…" (`ConversationDestinationOverlay.tsx`) lists the 25
newest chats, or the first 25 title matches. Paging was cut to meet the chat
line budget.

impact: an older chat whose title the user does not remember cannot be picked;
the user must search by title.

resolved when: the owner accepts the limit, or paging returns (~30 formatted
lines) and a 30-chat account can pick its oldest chat without searching.
