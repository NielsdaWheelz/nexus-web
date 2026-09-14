status: in progress
origin: 2026-09-13 bounded reader session review
area: reader query residency

`DocumentReaderSession.close()` released every query reservation, including
published find, index, context and overlay leases still retained by their
consumers. a parent close could therefore leave rendered rows or pdf geometry
alive without their payload charge.

keep published query reservations owned by their existing lease consumers.
close aborts all requests and withdraws unpublished work; pending physical reads
remain charged until settlement. no new cache or registry is needed.

acceptance: an actual retained pdf layer survives parent close while its charge
remains; detaching that layer and releasing the exact consumer releases the
charge. unpublished close plus late physical settlement also releases its charge.
