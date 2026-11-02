# a scan status failure card covers the annotation on phones

origin: 2026-11-02 annotation emptying qualification, android emulator · area: web
connections feedback

in the phone highlight pane, an expanded `Scan status couldn’t be checked` card, with
transport copy (`Check your connection`), lay over the annotation. a tap meant for
the embed's link landed on the card.

impact: a transient read failure hides and steals taps from the writing beneath it.

evidence: lab case `t2 link`, failed 4 of 10 runs between 2026-11-01 and 2026-11-02 and
passed 6 of 6 before; latest failure lab 20261102-115915-0b2089638612, repeat 2. while
it failed, no `GET /connection-discovery/scans` reached the api though other calls did,
and every lab logs 19 to 90 `socket hang up` upstream failures in `scripts/serve.mjs`.
why the read failed is unmeasured, and so is whether a lab artefact causes it. the
annotation sends no request there; no mechanism ties it to annotation emptying.

resolved when a failed scan status read leaves the annotation visible and tappable, and
the read's failure cause is known.
