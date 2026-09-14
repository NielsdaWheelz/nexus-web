# EPUB asset and oracle plate reads still materialize the whole object

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: foreground image memory

## what is wrong

both routes are now admitted on the image budget — `media_assets.py` declares
`route_class=AdmittedImageRoute` on its single router (covering `/media/image`
and `/media/{id}/assets/{key}`), and oracle plates were moved onto a `plates`
sub-router with the same class — so a refusal is `503` + `Retry-After` rather
than a fight for RSS. what remains is that an admitted read still holds the whole
object resident:

- `python/nexus/services/epub_assets.py`: `get_epub_asset_for_viewer` returns
  `EpubAssetOut.data: bytes`, and `routes/media_assets.py` builds
  `Response(content=result.data)` with `Content-Length: str(len(result.data))`.
- `python/nexus/services/oracle_plates.py`: `read_oracle_plate_bytes` now reads
  through `read_object_checked` with `expected_size=metadata.byte_size`, so an
  oversized object is refused mid-stream, but the accepted object is still joined
  into one buffer before the route returns it.

## prerequisites

the service contract and its route must change together: turning
`get_epub_asset_for_viewer` into an iterator without editing
`routes/media_assets.py` breaks the build. note that swapping the chunk list for
a `bytearray` accumulator is **not** a fix — the final `bytes()` conversion has
the same 2N peak.

## proposed fix

return a bounded byte iterator from each service and have the routes answer with
a `StreamingResponse` carrying `Content-Length` from the metadata row, so the
declared size comes from the row and the bytes are never all resident.

## acceptance

serving a large EPUB asset or oracle plate does not hold the object in memory;
an oversized/truncated object cannot complete a response matching its declared
length. withhold the final declared-length chunk until exact EOF: otherwise an
oversized object can deliver a complete-looking prefix before failure. missing
objects and failures found in bounded prefetch can retain the current pre-header
storage error; failures discovered later interrupt the body after headers and
cannot become a new JSON error/status. accepted responses preserve exact bytes,
content type, CSP, cache controls and authorization.

2026-09-14 source reconciliation: both legacy routes currently verify only size;
EPUB resource rows have no digest, and Oracle's ETag names its plate UUID rather
than a content hash. do not invent a stronger digest claim during streaming.
the existing immutable member route uses the same storage iterator and has a
separate [close-ownership gap](immutable-member-stream-close-ownership.md).
its current product implementation yields up to 8 MiB per chunk with no smaller
chunk argument. final-chunk verification can overlap that chunk and one later
storage chunk; this fixed allocation still requires actual admitted-route
measurement. the proposed iterator alone does not close this ticket.
