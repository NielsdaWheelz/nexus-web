# the PDF paint page budget re-serializes the page for every candidate row

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: pdf highlights / reader capacity

## what is wrong

`python/nexus/services/pdf_highlights.py:623` measures the accumulated page size
by re-serializing the whole page per candidate row, so building an N-row page
costs O(N²) serialization work.

the misclassification half is fixed: a first row that cannot fit now raises
`ReaderContentTooLargeError(limit="index_bytes", measured=page_bytes)` — terminal,
not a retryable `E_READ_CAPACITY` — and the accumulated size is one named
`page_bytes` local instead of an inline expression.

## prerequisites

five modules share this measure-then-append shape, so the fix belongs in one
helper owned alongside `ReaderPublicationLimits` in `python/nexus/config.py`, not
in `pdf_highlights.py` alone.

## proposed fix

add an incremental page-charging helper beside the limits (charge each row's own
encoded size as it is appended, plus the fixed envelope) and route all five
call sites through it.

## acceptance

building a full page costs one serialization per row; an oversized first row is
still terminal; a page that fills the budget still returns its continuation
cursor rather than truncating.
