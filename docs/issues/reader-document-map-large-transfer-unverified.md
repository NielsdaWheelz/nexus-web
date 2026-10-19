# large reader document-map transfer needs release proof

status: open
origin: 2026-09-27, pr #398 authenticated browser acceptance
area: reader evidence delivery

the isolated `0245` browser returned document maps of 7,319,406 decoded bytes
for corpus item 177 and 9,889,670 bytes for item 101. local next dev sent no
`content-encoding`; this does not establish the production delivery size or
phone latency. both maps loaded and their note markers opened after the pane
rendering fix, so a production transfer defect is not yet established. pr #393
also measured 2,456,436 decoded bytes for pillow, 1,415,813 for augustine and
509,126 for montaigne. decode, render and device-memory costs remain unmeasured.

prerequisite: the exact deployed web/api and signed physical app. inspect the
response's transfer bytes, encoding, time to readable text and interactive
evidence, main-thread long tasks and device memory on the phone without logging
private content. if delivery is materially slow, repair compression or payload
ownership at the serving boundary, not in note markup.

acceptance: the exact production route and phone load both large maps, open
and return from a source note promptly. record the measurements and an explicit
interaction budget; close only when the current design meets it or a correction
is landed and remeasured. delete this ticket after that proof.
