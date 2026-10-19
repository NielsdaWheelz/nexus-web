# the oracle quote guard's false-positive rate is unmeasured

status: open · origin: 2026-10-04 oracle rewrite (cleanup/oracle-reauthor) · area: oracle generation

`synthesis._quotes` rejects a folio (`invalid_output`, no repair round) when any
generated text contains four whole words (18+ letters) in a row from any offered
quote; a candidate of fewer than four words is never matched. public quotes are
now the curated passages (≤286 chars, ~114 typical) instead of 1,200-character
chunk heads, but personal candidates still offer 1,200 characters, and common
phrases ("in the middle of the") can trip it. no real-model rate exists.

acceptance: the invalid_output rate attributable to the guard measured over real
readings; tighten the window if it rejects honest prose.
