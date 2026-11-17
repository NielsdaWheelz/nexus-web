# forward words count jumps and impossible positions as reading

status: open · found 2026-11-16 by reading at `fcd6843db` and in the lab · area: consumption activity

problem: `forward_word_position` sums `greatest(0, word_end - word_start)` per span with
no ceiling (`python/nexus/services/consumption/stats.py:168,194-195`). a contents or
search jump inside one 30-second span counts the whole skipped distance as read.
ingest never checks positions against the work's length or kind
(`python/nexus/services/consumption/activity.py:28-60` checks only the time window,
read access, capture keys and overlap).

evidence: a lab seed that posted word positions for a 25-page pdf showed
"diffusion.pdf · 8h 2m · 113,972 words" in stats (screenshot `now-dark-week-2.png`,
2026-11-15). the real web client sends no words for pdfs, so this needed a crafted
request, but any client defect would land the same way.

proposed fix: a per-span ceiling (about 900 words a minute for text; 0.25 pages a second
for pdf progress; audio position advancing more than 4× the wall clock) applied to
forward totals, and ingest refusing word positions beyond the work's word count.

resolved when: a span that jumps 20,000 words in 10 seconds adds nothing to forward
movement, and a word position beyond the work's length is refused or clamped.
