# production chat pane crash remains unattributed

status: open; awaiting recurrence or retained initiating evidence
origin: 2026-09-25 user report, reviewed 2026-09-27
area: chat incident

the user reported production pane crashes with Retry in new and existing
chats, then a later response that paused. on 2026-09-25 the user said the
earlier crash was one or two weeks old and not reproducible. no retained first
browser exception or failed request identifies its cause. the later
`invalid_request`/uncertain dispatch belongs to the old deployed codex path;
isolated replies on the new shell route do not prove the earlier pane crash
was repaired. production still pointed to
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` during the 2026-09-27
read-only audit.

if it recurs, capture the existing sanitized client-defect event and first
failed request, correlate any accepted command/run and worker/host evidence,
then repair the detecting owner. acceptance is reproduction of that trigger
followed by a successful same journey without duplicate generation or effects.
a fresh new/existing-chat journey may qualify a release while this separate
incident remains open and explicitly unproved.
