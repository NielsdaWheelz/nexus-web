# a growing predecessor can displace a clamped date arrival

on `9aff45f4b`, a fresh single-pane visit to `/daily/1862-01-02`
rested at scroll offset 121 on the preceding day. that day held nine 1 mib
notes and grew the scroll extent above 3.1 million css px. the intended date
was in the local index but no longer mounted. scrolling to the live maximum
made it visible. this observation covers direct workspace entry with a short
last day.

the same chooser failure was reproduced at `6ea76e995`. `15e15f096` kept its
selected heading at 303.5 css px while the predecessor grew from 320 to 7,772
css px. the chooser receipts are `takeover-clamp-red-v2-034121/clamp-chooser.json`
and `takeover-clamp-green-034603/clamp-chooser.json`. direct entry under the
nine-body fixture still needs the equivalent measured result.
