# source menu can retire before its first command

status: intermittent initial-publication concern; cause unconfirmed.

on 2026-10-20, production lab run `20261020-081748-d4f094e080af`
at `46fea7db9` displayed the message menu, then announced “actions changed.
reopen to see current options.” before source-walk activation. run
`20261020-082843-87bb4b2a0107` at `8a1f08d27` similarly retired the mobile
sheet before activation. neither executed a command or changed the destination.

reproduce with a completed cited chat and its first source already in another
pane. during initial page layout, open the assistant message's options and
choose “walk through sources”; also try desktop-to-narrow entry. the composer
may still be resolving model availability. later desktop source reuse and
three measured repetitions passed with unchanged trigger/menu/row geometry;
those passes do not explain the earlier retirement.

resolved when the invalidating meaning or geometry value is captured and shown
to be an expected change, or its responsible publication fault is repaired and
the same live journey passes. keep the frozen-menu guard; do not add retries,
delays or speculative lifecycle machinery.
