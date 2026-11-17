# a qualifying day costs one keystroke

status: open · found 2026-11-16 by reading at `fcd6843db`; not run · area: consumption activity

problem: reading stays eligible for five minutes after the last trusted input
(`apps/web/src/app/(authenticated)/media/[id]/activity.ts:16`, `IDLE_AFTER_MS = 300_000`),
and a day qualifies at 300,000 ms of effective time
(`python/nexus/services/consumption/stats.py`, `_QUALIFYING_DAY_MS`). one keypress in a focused, visible
reader followed by five minutes without further input can make a qualifying day and extend
weeks running.

impact: counted days and weeks running can be held by an open page; any "lingering" or dwell figure includes the idle tails.

unapproved option: count qualifying time, and any dwell or "unbroken" figure, only over spans
within two minutes of a position change (word, progress or media position); viewing,
which carries no positions, counts as now. computable from stored spans
(`stats.py`, `_base_sql` reads the stored measurements).

stationary reading is legitimate. neither the two-minute threshold nor
position-based qualification is approved; they trade false activity against
undercounting real reading.

resolved when the owner records the chosen qualification policy. if the proposed
rule is adopted, verify that an unattended five-minute page does not qualify
while a slow reader turning a page every ninety seconds still does.
