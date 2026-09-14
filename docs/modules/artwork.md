# artwork

scope: mutable covers and player artwork. reader figures use retained publication
assets; oracle plates use their existing owned-image path.

## contract

- the API fetches at most10MiB per image, validates public origins on every
  redirect, and accepts only identity-encoded upstream bytes. it retains no
  image cache. private browser freshness lasts24hours; no fabricated validator.
- foreground validation runs in one Linux child under required address-space,
  CPU and wall limits. limits precede decoder imports; anonymous input/result
  descriptors carry original bytes and a fixed result. parent death kills the
  child; return, timeout and cancellation wait for actual termination. worker
  ingestion retains its existing bounded child without nested isolation.
- one admitted image also occupies a foreground-read permit. refusal is503
  `E_READ_CAPACITY` with `Retry-After`, before source bytes or request dependencies.
  both permits outlive validation and actual response transfer, including caller
  cancellation. readiness and progress use reserved headroom outside that pool.
- successful image bytes carry exact length and validated display-oriented
  `X-Nexus-Image-Width`/`Height`. the BFF forwards these on its identity byte lane
  and removes representation headers when replacing a failed response.
- web display demand owns artwork leases. equal source and requested dimensions
  share one derivative; only visible images and the current media-session cover
  request leases. one producer owns fetching, decoding and derivative creation.
- concurrency is bounded by the residency budget, not by a separate constant:
  at most `floor(residentPixels / maxDimension^2)` demands can be admitted at
  once, and the producer decodes one at a time. admission is first-fit in
  arrival order with pass-over-once: a demand larger than the remaining headroom
  may be overtaken by a smaller later arrival exactly once, after which it is
  the exclusive next admission. a demand is therefore never starved by a stream
  of small ones, and no skip-count threshold is invented.
- the shared read policy owns retries, server backoff guidance and exhaustion.
  last-consumer release aborts transport and revokes the object URL. an
  unabortable decode retains its producer reservation until it actually ends.
- artwork uses an aspect-preserving, display-sized static first frame. decoded
  bitmap and canvas belong to the producer; its output URL belongs to consumers.
  retained derivatives obey a measured pixel-residency profile. pixel arithmetic
  describes admission; browser/process measurements establish actual memory cost.
  the retained encoded derivative (a lossless PNG blob behind each object URL) is
  measured in the capacity receipt as `derivativeBytes` but is not reserved: only
  decoded pixels are charged. a combined byte budget is not yet committed.
- exhausted or permanently invalid artwork is visible as a feature-owned
  failure/fallback with feature-owned retry. image leaves never insert nested
  interactive retry controls inside links or buttons.
- native playback owns one current-track derivative in media metadata. preview
  artwork uses the fixed authenticated origin proxy; canonical artwork retains
  its remote origin. `Connect` retries a failed current cover. account/session
  replacement invalidates pending work; a late completion cannot publish to
  another track. metadata updates retain the audio item, position and state.

## qualification and costs

release is pending the measured API/host envelope and native consumer proof.
numeric derivative limits are required inputs; there is no qualified
production fallback. capacity experiments separately record cold imports,
selected-provider first use, admitted overlap, original decode/canvas/blob peak,
retained decoded surfaces and release. successful small leaf proofs do not
qualify the workspace or native WebView.

costs: new browser fetches repeat upstream I/O; image sources that ignore identity
encoding are rejected; animated artwork becomes its first frame; derivatives
consume client resize work and a finite limit may soften very large/high-dpi
artwork. foreground validation adds a process startup and overlapping input
buffers. synchronous request cancellation can wait until the child's hard wall
deadline and termination; its permits remain occupied. decoder memory/time
denials use the existing resource-limit result, while unexplained child failure
remains a defect. over-budget visible demands wait for another consumer to
release its lease. native artwork adds PNG encoding and Media3 decoding, and an
exhausted OS cover stays missing until the existing reconnect action. Android's
synchronous decode is not preempted by the read deadline; a late result is
discarded after its real producer finishes. reader figures retain their source
fidelity.

PNG display orientation follows the single pre-IDAT eXIf ordering in
[PNG third edition table7](https://www.w3.org/TR/png-3/#5ChunkOrdering).
orientation reads only its inline IFD0 scalar. JPEG validation omits APP metadata
from its bounded copy so Pillow's unused DPI lookup and MPO auto-promotion cannot
materialize unselected EXIF values; original response bytes remain unchanged.
