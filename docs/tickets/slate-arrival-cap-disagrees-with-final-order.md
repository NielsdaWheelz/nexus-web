# slate arrival admission and final ordering need one contract

status: open. origin: 2026-10-04 source audit at `58ba9d45`; area: resonance arrival slate. priority: p3.

`resonance/_evidence.py:336–348` caps qualifying arrivals after ordering every episode before every publication on the same arrival day, regardless of which reason occurred that day. `_slate.py:234–246` instead ranks the strongest reason on each candidate's newest day. a 21-candidate source construction shows the sql cap can omit a candidate final ranking would place first. whether admission must preserve the final top 20 is not yet established; a coarse prefilter may be intentional. this is an ordering-contract gap, not a verified user-visible bug or runtime observation.

settle the admission/final-order requirement first. if exact top-20 preservation is intended, align admission with the newest-day comparator while retaining date, instant, tie, visibility and cap rules. acceptance: a documented requirement and actual 21-candidate sql admission/pure final-order comparison, or a documented coarse-filter rationale that makes the distinct ordering intentional.
