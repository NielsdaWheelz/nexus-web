# image validation expands compressed metadata twice

- status: open
- origin: 2026-09-13 bounded-workspace capacity investigation
- area: API image proxy and publication image validation

`python/nexus/services/image_validation.py:314` opens an image, verifies it,
then opens it again while the first image remains referenced. pillow12.3.0
`PngImagePlugin._open` decompresses text metadata before pixel data;
`MAX_TEXT_MEMORY` allows64MiB of aggregate text. a10MiB encoded-byte limit
therefore does not bound validation to10MiB, and the second open can overlap
both expanded metadata dictionaries. the validator also leaves pillow's
metadata-limit `ValueError` outside its invalid-image error boundary.

first capture dimensions/format and verify in one image context. preserve
format-integrity rejection. measure valid compressed-metadata PNGs alongside
JSON reads in the owned API capacity workload before selecting image admission.
classify metadata-limit rejection as an invalid image rather than an API500.

acceptance: coherent validation proof rejects malformed/excess metadata through
the existing error contract; measured exact-image receipt includes compressed
metadata and overlapping reads, with no guessed replacement allocation budget.
