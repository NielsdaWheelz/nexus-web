status: open
origin: 2026-09-13 bounded reader integration
area: immutable publication figure admission

captured publication assets retain bytes/digest/type but no decoded geometry or
animation facts (`ReaderPublicationCapturedAsset` in
`python/nexus/schemas/reader_publication.py`). web preparation discards the
validated width/height when constructing this record
(`services/reader_publication_web.py:102`). epub preparation only verifies
asset bytes (`services/reader_publication_sources.py:140`). native's entry
contract permits 512 mib assets, with an 8 mib svg bound
(`OfflineReadingPackageContract.kt:13`). artwork's 4096-axis/static-derivative
policy therefore cannot establish document figure support.

prerequisite: attest actual raster type, oriented dimensions and animation frame
facts to the retained asset digest during preparation/local conversion; retain
the original asset. then measure browser/native decoder peaks for the existing
asset envelope and derive visible-demand admission/release limits. svg instance
expansion has its separate ticket. do not decode first and count afterwards,
freeze figure animation, or silently apply artwork limits to document content.

acceptance: actual retained figure rendering (including animation), stale-demand
withdrawal and source replacement stay within measured view/transition budgets;
maximum supported source behavior is explicit and complete. capacity feedback
alone is not evidence that the existing source envelope is supported.

review 2026-09-14: `publicationDom.ts:100-111` already defers image URLs;
no visible figure admission owner currently supplies them. web validation
checks only the initial oriented canvas, not animation facts; EPUB stores
raster bytes without geometry validation (`epub_ingest.py:871-897`). MIME
attestation is tracked separately in oi-166.

no decoder has been selected. [libvips's own checklist](https://www.libvips.org/API/8.16/Developer-checklist.html)
records a progressive JPEG thumbnail using roughly 4 GB where its sequential
encoding uses 72 MB. [its WebP loader](https://www.libvips.org/API/8.18/ctor.Image.webpload.html)
explicitly lacks shrink-on-load for animation. a thumbnail API alone is not a
resource bound. qualify the actual format/decoder path, including visible
animation and transient allocations, before choosing a budget or derivative.

2026-09-14 decoder inspection: pinned Pillow's GIF `n_frames` walks with
`update_image=False`, deliberately omitting later canvas growth. ordinary frame
`seek` can load the previous pixels and allocate disposal surfaces. ICO opens
and decodes its initially selected image; directory dimensions alone do not
attest other embedded PNG/BMP dimensions. neither is a metadata-only bound.
libvips, ImageMagick and ffprobe are absent from the current host and backend
image dependencies. full-frame inspection is a staged preparation experiment,
not activated capture or release qualification. it has no production caller, so
it now lives with its proof in `python/tests/capacity/test_reader_raster_facts.py`
(the API image memory qualification owner) rather than in `nexus/services`;
activating capture means writing the production owner then, under a chosen
admission budget. measure it through the existing physical worker reservation
before choosing that admission.

format closure also remains part of activation: web `IMAGE_FORMAT_MIME_TYPES`
accepts BMP and ICO. Python now admits their BM / ICO signatures in
`offline_reading_packages.py:990–993`; native `OfflineReadingPackageVerifier.kt`
still omits both MIME signature branches. schema-two validation uses MIME and
does not require a filename suffix, so those branches preserve existing web
formats. the suffix map applies only to schema one; historical EPUB admission
did not permit BMP/ICO, and this correction must not broaden that contract.

full-frame inspection is not yet a complete malformed-animation attestation:
pinned `PIL/GifImagePlugin.py::_seek` reports the same EOFError for an explicit
GIF trailer and missing bytes. `PIL/ImageFile.py::_get_oserror` also collapses
decoder allocation (-9), configuration (-8) and malformed decoding (-2) statuses
into plain OSError. qualify actual truncated-later-frame/browser behavior and
classify only established malformed results; unknown/system errors must preserve
the original and fail preparation. no generic OSError-to-InvalidImage catch.

native inspection 2026-09-14: java image-info dimensions alone do not expose
frame traversal. the public [ndk image-decoder header](https://android.googlesource.com/platform/frameworks/native/+/master/include/android/imagedecoder.h)
exposes fd ownership and animation frame advance/info from api 31, below the
existing offline minimum api 34. no jni owner or codec is selected. actual
shared gif 2×3-header/8×9-frame and ico 8×8-directory/32×32-png cases from
`tests/capacity/test_reader_raster_facts.py` still need native observations; header dimensions
are not a parity proof. physical device verification was subsequently waived; host observations must
remain explicitly scoped.

2026-09-14 host capability inventory: pinned robolectric 4.14.1 contains
`ShadowNativeImageDecoder`, `ShadowNativeAnimatedImageDrawable` and their real
native bridges. public Java decoder behavior can therefore be probed on this
host. native-runtime 1.0.16 exposes skia C++ symbols, but no `AImageDecoder`
NDK exports; the Java bridge has no frame-enumeration API. private skia ABI calls
are not a supported production boundary and have not been used. no native
GIF/ICO dimension/frame parity has yet been observed.

independent Python raster source artifact is retained at publication-proof
`test-results/runs/3c5e13747bb3e4b8/reader-raster-source-facts.json`, sha256
`6930524638e1506dab43090c812700b7748ccade552b9da15ae5f01116fe2944`.
the entire command is now green `3c5e13747bb3e4b8`, including GIF/ICO,
orientation, WebP, BMP and AVIF cases. physical-handset verification is waived on this vps;
any following evidence must name the actual host/native boundary.

the [official ndk reference](https://developer.android.com/ndk/reference/group/image-decoder)
defines frame rectangles within the header width/height and frame advance as
animation traversal. neither statement establishes later encoded GIF canvas
growth or enumeration of ICO alternatives. actual native source observations
remain necessary before selecting this API for the shared all-frame facts.

ordinary host characterization is staged in `OfflineReadingRasterDecoderTest.kt`
for the next full host lane. it reads the exact retained fixture bytes from
`testdata/offline-reading/reader-raster-source-facts.json`, calls public
ImageDecoder with software allocation, and checks independently authored first
pixels while recording header/selected dimensions. it does not infer a frame
count or all-frame maxima. no execution receipt yet; no raster wire activation.

public Java [ImageInfo documentation](https://developer.android.com/reference/android/graphics/ImageDecoder.ImageInfo)
confirms the available facts are size, mime type, color space and an animated
boolean. `isAnimated` is not a frame count. the ordinary probe retains these
observations without promoting them to the shared all-frame contract.

current MAIN consumer audit: `publicationDom.ts:50` introduces
`applyReaderUnitResources`, and `MediaPaneBody.tsx:2658/2719/2734` calls it
for prepared roots. it assigns original selected-member URLs through
`DocumentReaderSession.memberAssetUrl` without encoded-asset/decoded-surface
admission, visibility or an asset lease. only unit JSON/DOM nodes were admitted.
typed and memberless vector references remain deferred. client disclaims this
unreviewed activation. root residency proof holds current source; no source
change has been applied. exact current/candidate identities and narrow restoration
to deferred resources are retained in `/tmp/reader-original-assets-unadmitted-shas.json`
and `/tmp/reader-original-assets-unadmitted.diff`. restoration alone leaves
figure support incomplete; it is not acceptance or a replacement for activation.

2026-09-14 reviewed correction: after source hold release, applied only root-
approved patch `9c06cd1f...` removing the unadmitted helper, unused session seam
and its three calls. final publicationDom/session/body hashes are
`32ccc835...` / `ff42eac0...` / `4cb9013a...`. original raw resource records
remain deferred. this removes premature activation; figure acceptance stays open.
