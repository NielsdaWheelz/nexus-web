# a work cannot be cited from the line by name

status: open · deferred by the owner in the 2026-11-12 composer interview · area: web / librarian composer, drafts

a draft carries at most one passage, and only one captured from a reader selection
(`apps/web/src/lib/chat/drafts.ts:14`, `quote: ReaderQuote | null`). admission
already takes sixteen attachments (`python/nexus/schemas/chat.py:89`). nothing lets
the line attach a work or a passage by typing its name.

impact: comparing two works means opening each and selecting text first. a work
named only in prose grants the librarian no reference.

it needs its own decision on several attachments per draft, selection inside the
line and the draft's shape. the current [chat contract](../modules/chat.md)
retains one quote; this follow-up does not change that boundary.

resolved when a draft can attach a named work or passage without leaving the line,
or the owner declines it.
