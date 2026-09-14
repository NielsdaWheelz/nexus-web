# native publication metadata memory qualification

status: open
origin: 2026-09-14 bounded-workspace native capacity audit
area: installed publication verification

`OfflineReadingPackageContract.kt:14–22` limits packages to 4,096 members,
512 mib aggregate bytes, and bounded individual json members. it does not limit
anchor records to 4,096. `OfflineReaderPublicationVerifier.kt` still retains
cross-member navigation identities and unit facts; anchor joins now use the
existing prepared sqlite index, as measured below.
the jfr range-read green `eba5f1fe64049569` proves bounded unit byte reads for
256 ranges; it does not qualify maximum retained metadata heap.

first finish original-id binding and canonical-boundary correctness. then run
actual valid near-limit member/anchor graphs through the verifier, counting
encoded members, anchor records, duplicate strings/runtime overhead and peak
host heap. use separate valid profiles for the 64 mib encoded legacy source and
schema-2 metadata maxima. do not mislabel member count as an anchor count bound.

acceptance: exact fixture recipes and byte identities, peak heap/read/storage
receipts for the supported bounds. physical-device verification is waived by
the user; no device claim follows. any required representation or admission
correction preserves supported sources.

2026-09-14 profile draft: the existing anchor proof now constructs 4,096
manifest-attested members incrementally, with 997,960 visible source elements
and 1,995,920 distinct id/name anchors across 21 fragments. each full fragment
has 48,800 elements, below the hosted epub entry cap; total leaves room for
xhtml wrappers below the book cap. 44-code-point ids bring encoded members
near the aggregate limit, asserted before verification. this is a retained
wire-graph workload, not an archive claimed to come from the worker. the baseline snapshot was `674b4243c0`.

observed `104ba8ddd92809b8` at `674b4243c0`: 520,633,402 expanded bytes,
1,995,920 anchors, 106.199 s verification and 503,188,280-byte sampled heap
peak (512 mib host jvm). source/identity assertions pass, but this does not
qualify native capacity. root approved existing preparation sqlite as the
replacement owner; replay the same graph with explicit disk/transaction costs.

current correction uses the existing private prepared index. pending exact
(href, id) keys are consumed in source-unit order inside its transaction, then
dropped and vacuumed before hashing. format 2, revision and the installed digest
are mandatory for every epub (including zero anchors) and table package. the
member-verification result is explicitly incomplete until preparation succeeds.
old prepared indexes rebuild locally; any failed deferred join/rebuild preserves
attested members and pending progress. no second database or anchor limit.

the unchanged maximum graph now measures member verification separately from
retained source copying, preparation and readiness. sampled main index, journal
and linux sqlite vacuum temporary file bytes accompany heap/process observations;
original/candidate overlap is reported separately. corrected receipt is below.

2026-09-14 scope correction: the user waived physical-handset verification on
this vps. native compilation and host qualification remain required; no device
behavior or capacity claim is made.

source-admission qualification limit: `epub_ingest.py:93` also caps original
book attributes at 1,000,000. this retained-wire graph has 1,995,920 id/name
attributes. its element counts fit the separate element caps, but it is not a
producer-realizable epub source recipe. keep the unchanged accepted native wire
graph as the regression stress case; qualify actual producer/legacy maxima
separately rather than claiming the synthetic graph came from that importer.

anchor-map correction is canonical green `bd88629aa9ca0584` at `48179353b7`:
the original 520,633,402-byte graph/hash/revision is unchanged. candidate sampled
heap is 246,886,688 bytes; member verification plus copy/preparation/readiness
67.908 s. temporary index peaks at 179,613,696 bytes, journal 8,720; final index
61,440. sampled source/candidate/private-disk upper bound is 1,222,171,514 bytes.
zero sampled vacuum-temp bytes does not establish their absence. these are host
observations, including framework/fixture effects; they establish the anchor
allocation correction, not every metadata/source capacity bound. section and
navigation maps still need their own actual aggregate shape qualification.
the same audit must include the cross-unit `embedIds`/`embedKeys` sets and
contents `displaySections`/`tocIds` sets in the verifier; the 4,096-member limit
alone does not bound their record counts either.
