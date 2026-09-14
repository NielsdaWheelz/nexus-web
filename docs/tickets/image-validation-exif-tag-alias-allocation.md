# image validation expands unselected exif tag values

status: open
origin: 2026-09-13 bounded-workspace runtime implementation
area: api image validation / pillow12.3

`python/nexus/services/image_validation.py:315` opens external bytes in the API.
the pinned pillow `Image.py:4159` delegates `Exif.load` to
`TiffImagePlugin.py:886-936`, which reads and retains every referenced IFD value.
distinct tags can reference the same encoded region: their aggregate retained
bytes are not bounded by the input's10MiB limit. `JpegImagePlugin.py:502-507`
can invoke this during `Image.open` when JPEG dpi must be read from exif.
actual exact-deployed-image receipt `043599ef91d1ad0c` reproduces this: one
63,839-byte JPEG with2600 distinct private tags sharing32,000bytes kills the API
137/OOMKilled at335,544,320bytes. memory.events max101/oom1/oom_kill1. fixture
sha256`db1897f0c8afbc1ce418b65be3f6a00d06385b15bd93438c233a46ca02572e9c`.
the scoped test-origin transport is declared in its attached capacity artifact;
there were no concurrent reader requests. do not run an amplifying input on the
unbounded host.

prerequisites: controller-owned isolated image capacity experiment; preserve
its cgroup receipt if validation is killed. characterize a bounded increasing
alias corpus and trace the actual eager-DPI entry condition. a new orientation
reader must inspect only the scalar orientation entry, not materialize all EXIF.

fix the image validation owner so unselected metadata cannot allocate beyond
its explicit admitted envelope. retain supported display formats/orientation;
do not hide the problem with a lower arbitrary image or metadata limit.

JPEG's candidate validation view now removes APP metadata before Pillow; its
green capacity receipt is pending. AVIF's pinned `_open` also calls `Exif.load`
and remains unresolved. ICO eagerly decodes its embedded PNG/BMP, so its pixel
allocation needs inclusion in the qualified envelope.

the proposed `imagesize`2.0 replacement was audited at
`cf87fc06d599c71b61564eca97873b7bc75ab49a` and rejected without installation.
[`_parse_iloc`](https://github.com/shibukawa/imagesize_py/blob/cf87fc06d599c71b61564eca97873b7bc75ab49a/imagesize/imagesize.py#L480)
allows zero offset/length/index widths, then allocates up to65,535 extent tuples
without consuming another byte per extent. each six-byte v0 item can repeat
that allocation. this is a source-established hazard, not an executed benchmark.
its PNG/WebP paths omit EXIF orientation; its AVIF `irot` parser expects a
five-byte full-box payload instead of the one-byte property. header recognition
alone also cannot replace the current format validation contract.

acceptance: actual public API validates supported alias-bearing inputs within
the qualified envelope or rejects malformed metadata before amplification;
readiness/progress stay available, and the proof fails under the old eager path.

staged correction: foreground validation now runs in the owned hard-limited
child (`services/image_decoder.py`, `image_decoder_child.py`), while existing
background ingestion keeps its current bounded worker child. canonical actual
CPU/parent-death/lifetime proof passed `b58dc4f7de7704bf`. frozen API alias +
maximum PNG metadata + progress trial `512035dbb20c3d80` passed: API cgroup
388,591,616-byte peak; current-image child high-water ~41/110 MiB; no OOM/max
and both progress acknowledgments. this closes the uncontained foreground
allocation mechanism in staged code; full mixed-worker/browser/device profile
qualification and release activation remain outstanding.

the lower-level libavif metadata seam was also rejected as a complete memory
bound: BMFF item/extent counts permit allocation independent of the compressed
pixel dimensions or selected metadata value. the existing read-only v1.3.0 audit
at `/tmp/nexus-libavif-audit-20260913` is retained. no additional pathological
fixture or benchmark is required to justify the process containment boundary.
