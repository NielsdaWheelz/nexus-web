# inspect the shadow & claw and pillow book imports

status: open
origin: 2026-09-11 reader-map council; affected title supplied in session
area: reader defect reproduction and acceptance

the reported affected book is shadow & claw by gene wolfe; the follow-up also
names the pillow book as required acceptance material. inspect each exact
imported edition without assuming section counts or numbering. static audit
found independent missing-heading and transitive-clustering mechanisms, but
the actual editions' sources and imported projections have not been inspected.
the bounded read-only dev lookup on 2026-09-11 reached no database:
`localhost:54320` refused both ipv4 and ipv6 connections. no query executed.
audit baseline: `7fa89b88c8342bca9edfb46a6d20053c49555fb2`.

prerequisites: authorized access to both existing imports/sources and a running
reader environment. use the exact editions; another epub of either title is not
an equivalent reproduction.

proposed fix: compare raw spine/toc/headings, persisted navigation offsets,
document-map markers, and rendered clusters. identify which layer loses the
chapters. retain only minimal structural evidence or a small authored analogue
in public fixtures; do not publish the copyrighted book.

acceptance: in both books, source-backed sections survive extraction and presentation with
correct proportional lengths; local/global position and highlight targets
agree; each chapter/highlight jump reaches its source. record the source
fingerprint, candidate revision, and controller-owned proof receipt.
