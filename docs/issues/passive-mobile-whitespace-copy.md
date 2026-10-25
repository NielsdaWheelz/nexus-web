# passive mobile copy admits whitespace captures

source-only gap at `4a5b1c710`; no trusted native reproduction yet.
`apps/web/src/lib/documentReader/text/geometry.ts:345-363` accepts a positive
canonical range without a nonblank-text condition. the passive mobile menu in
`apps/web/src/app/(authenticated)/media/[id]/SelectionDock.tsx` copies its frozen
capture without checking nonblank text. an admitted whitespace-only selection
could replace clipboard contents with whitespace.

the highlight-popup change guards composer copy; its scope preserves the passive
selection bar. reproduce with a trusted whitespace-only text selection before
changing that capture/control contract. resolve by proving such captures cannot
be admitted, or guarding passive copy eligibility while preserving original text
and native selection gestures. verify a clipboard sentinel survives blank copy
and ordinary selection still copies its exact captured text.
