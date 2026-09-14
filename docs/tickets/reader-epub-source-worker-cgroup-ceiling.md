status: open
origin: 2026-09-14 bounded-workspace capacity run f52060eb73f93122
area: epub source preparation / worker memory

candidate `3d94f19f48` worker image `sha256:c5ca25a779482408fcd4e08acb02bc1eb3c52d82c2eda13b58e2b8aa79504489`
publishes the actual 67,108,864-byte HTML-plus-canonical source in 108.56 seconds,
but `memory.peak=469762048` equals its 448 mib cgroup limit; `memory.events.max=342`.
no oom or kill is observed. source sha256 is
`13e4fd7061b4d77ddc1984f205fa0bf787d448bb86ce96aecef51977074c90d6`.
receipt: `nexus-web-bounded-web-proof/test-results/runs/f52060eb73f93122/api-capacity-candidate-worker-epub.json`.

inspect source parsing, canonicalization, segmentation and publication live ownership;
remove unnecessary overlapping source representations before choosing measured capacity.
retain this exact sparse source, then qualify dense words and other accepted shapes.
the concurrent artwork fixture failed its file-permission setup, so that overlap is
not qualified even though worker pressure is independently observed.

corrected harness run `8bb58bd302499f69` at `cbafe2b6fe` verifies all 516 units,
original paths, word boundaries, find and quote resolution; artwork, progress and
readiness overlap all return 200. source completes in 109.55 seconds, but the worker
still peaks at 469,762,048 bytes with 715 ceiling events and no oom/kills. first
observed pressure includes 342,441,984 anonymous bytes and 70,164,480 file bytes.
worker image: `sha256:7cc31947933de3b047800c45cf48a70293e2601aeb4118595c448668c0e83dc8`.

new splitter run `b2a6870535f4fc71` at `b0403a9ce4` still fails headroom: worker
peak 469,762,048 bytes, 614 ceiling events, zero oom/kills; source completes in
109.98 seconds and all 516 units and source queries remain exact. source-child
high-water rss falls only from 331,767,808 to 323,809,280 bytes. first pressure
has 332,378,112 anonymous and 70,365,184 file bytes. worker image:
`sha256:68801a548b582ade75a5086b7771988286472c56fe1ede8e46a523f883165d83`.
next diagnostic observes the existing source-stage scalars and packaged node
children in the same cgroup; it adds no application profiler.


read-only validation audit: `reader_publication_sources.py:161-170` passes each
fragment from the still-live extraction plan into `split_reader_publication_fragment`.
its initial validation (`reader_publication_units.py:402`) rebuilds a complete
canonical string through `generate_canonical_text_with_element_offsets`, then
compares and discards it. `CanonicalTextBuilder.build()` keeps the raw event text
while NFC, blank-line collapse and line trimming allocate intermediate strings.
this is separate from the already-spooled unit bodies and completed word child.

`CanonicalTextBuilder.project_markers(expected=..., chunk_codepoints=65536)`
already validates each emitted canonical segment and final length without a new
whole canonical output. reusing that exact transform for publication validation
would first require removing its empty-marker early return: no-id sources must
still be compared completely, including empty-source and terminal-length cases.
the raw event buffer, extraction-plan HTML/canonical/block objects and indivisible
normalization-cluster cost remain. wait for stage/node diagnostics before choosing
this cut; this audit is not a measured allocation attribution.

acceptance: actual source completes with all source/locator/query assertions,
zero cgroup ceiling/oom events, responsive progress/readiness and actual artwork overlap;
record exact images, source hashes, full phase samples and required host reserve.

run `71e44d03ca91ca18` at `1700c6d987`: all 516 units verify, source completes
in 112.366 seconds, reader/readiness/progress/artwork all return 200. worker
image `sha256:3f511fb9ac2a69ad33d1ff0b4a1d18d47a7b6cae40a0a76843990cbca801582b`
again peaks at 469,762,048 bytes with 826 ceiling events and no oom/kills.
first observed pressure is within coarse `Extract` progress: 334,090,240
anonymous bytes and 68,440,064 file bytes. the source child reaches 336,048,128
rss bytes. the only sampled word-boundary child reaches 100,032,512 high-water
rss bytes later; 0.5-second sampling cannot exclude earlier short children.
this locates a phase, not an exact allocation. indexing completes 4,100 chunks;
metadata socket permission and bulk graph teardown failures remain separate.

`a4f6e118079a369e` at `012606a32417b19ca2fb2a0577db5ec9d43bc24f` includes
the no-copy canonical validator: source completes in 112.459 seconds, but worker
peak remains 469,762,048 bytes with 906 ceiling events and zero oom/kills. first
pressure: anonymous 330,711,040 bytes, file 88,997,888 bytes; source-child HWM
329,789,440 bytes. metadata and complete indexing now succeed. this remains a
failed headroom result. retained receipt: `api-capacity-candidate-worker-epub.json`.

read-only phase reduction of that receipt: chapter sanitation reaches 4/4 at
17.62 seconds after worker start; first pressure follows at 19.03 seconds;
finalize begins at 120.17 seconds and source completion is observed at 124.21.
the source contributes 599 ceiling events; follow-up indexing raises the total
to 906. `Extract` therefore also spans publication preparation. do not attribute
all 906 events to extraction or treat coarse progress as an allocation profile.

2026-09-14 integrated replay `815aca6a7ea47827` at `03863b4f9d0a90cde3be7cfa8cba1714efce94f9`
still fails headroom with source spooling, bounded index batches and cleanup.
the identical source `81243ea5993f53aeb1c296efc6354377d676cfc116a4121a5c9b9b46d087d3de`
publishes all 516 verified units in 117.136 seconds. source-child hwm falls from
329,789,440 to 247,975,936 bytes, but first pressure at 20.028 seconds has
248,664,064 anonymous and 174,915,584 file bytes. first pressure follows the
fourth extracted chapter at 18.464 seconds. source completion records 192
memory-max events; follow-up jobs bring the count to 918 and cgroup peak to
471,781,376 bytes against the unchanged 469,762,048-byte ceiling. no oom or kill
occurred. spooling reduced anonymous residency while increasing file-cache
residency; it has not qualified the complete worker.

the 4,100-chunk reindex and cleanup both complete; one heartbeat lock timeout
remains during reindex, down from twelve in the earlier receipt. api peak is
426,934,272 bytes with no memory-max events; overlapping reader, progress and
readiness requests complete in 86, 77 and 36 milliseconds. these are sampled
fixture observations, not release limits. inspect source-file, current-chapter
and word-boundary child overlap before selecting another implementation or
resource profile. the retained receipt is
`nexus-web-bounded-web-proof/test-results/runs/815aca6a7ea47827/api-capacity-candidate-worker-epub.json`.

word-input lifetime run `790372c5d74b0ca6` at committed `fe6e19db5e` still
fails headroom: peak 470,482,944 bytes against 469,762,048; 1,026 ceiling
events and no oom/kill. source child hwm is 247,422,976 bytes; source finishes
in 112.791 seconds and all 516 units and word slices remain exact. both
follow-up jobs complete, and overlapping api requests return 200. receipt:
`nexus-web-bounded-residency-proof/test-results/runs/790372c5d74b0ca6/api-capacity-candidate-worker-epub.json`.
closing the input tempfile earlier is not evidence that this worker profile
is qualified. first retained pressure sample has 299,143,168 anonymous and
148,488,192 file bytes; samples do not establish the remaining allocation owner.
