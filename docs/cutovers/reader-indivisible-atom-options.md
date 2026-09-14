# indivisible reader atoms

status: design comparison; no wire, source limit, or admission change selected
origin: 2026-09-14 native converter capacity review
area: hosted publication, retained conversion, shared text reader

the accepted-source failure is real: native receipt `0855e169907e194d` accepts
the attested 262,390-byte source, then cannot publish its single 65,537-point
grapheme. the original source survives. that preservation is recovery, not
completed reading support. see the [open issue](../tickets/reader-indivisible-grapheme-capacity.md).

the invariant is stronger than storing every code point. canonical positions,
original source markers, authored inline structure, shaping, copy, and selection
must still address the same source. separate unit roots do not establish the
same shaping or selection as the original continuous run. inserting a break,
replacement character, dotted circle, or stream-safe separator changes that
contract.

## source maxima and actual implications

| accepted source | existing maximum | consequence for an indivisible atom |
| --- | --- | --- |
| browser article capture | 2 mib content html and 2 mib source html, each checked before preparation | the 65,536-point experiment is already smaller than accepted text; normalization and generated projection must be included |
| hosted epub | 16 mib decoded xhtml per entry; 64 mib aggregate sanitized html plus canonical utf-8 | one chapter can put almost its entire allowance into one cluster |
| retained schema 1 | 64 mib encoded reader json, including html, canonical text, and escaping | this is a separate input envelope; do not substitute the hosted per-entry limit |

these are source maxima, not unit maxima or physical-memory bounds. the native
archive's 512 mib expanded-member allowance and 4,096-member limit do not bound
one cluster to 65,536 points. all sources already accepted within the relevant
envelope remain in scope; no smaller atom cap is proposed.

the corrected epub witness is `q` followed by repeated `u+0344`. each mark uses
two raw utf-8 bytes and normalizes to two marks using four bytes. a chapter near
16 mib therefore approaches 16 million canonical points, 32 mib canonical
utf-8, and 48 mib combined raw-render plus canonical text. both producers retain
the original render text separately. this is a derived witness price; that
maximum source has not yet passed the actual publisher. nfc can expand, with a
general maximum factor of three in utf-8/16/32 code units. [unicode normalization faq](https://www.unicode.org/faq/normalization.html)

a simple retained-reader atom can similarly approach 64 mib combined text
fields, subject to the actual json envelope and escaping. the exact maximum
recipe must be admitted through the converter; an arithmetic estimate is not
an acceptance receipt. the current small acute-mark witness only establishes
the first failing boundary.

the next native profile is now specified exactly, but has not run. its existing
239-byte json envelope contains raw html `q + u+0344 × 11,184,770`, canonical
`q + (u+0308 u+0301) × 11,184,770`, and three trailing json spaces.
`239 + 2 + 6 × 11,184,770 + 3 = 67,108,864` encoded bytes; canonical length is
22,369,541 points. independent streamed byte construction gives source sha256
`d509331c3662b575b933d3ceef8217a7e155e7a567cc864ef2cfece40efca92c` and
canonical sha256
`70fa54c3125ae7c0e487478fd7df1de34dc57aaa09fbcfbd549810b97f3cf683`.
fixture construction stays outside measured native work. the probe must record
actual source admission, unchanged input, first failing stage and sampled memory;
a unit-cap refusal remains failed support. this is one exact maximum-size
profile, not a universal worst-case unicode bound.

actual native run `312e8d38541cb232` at `f254aca819` admits these exact
bytes and confirms the canonical hash and one ICU grapheme. cumulative source,
html and spool-plus-ICU stages finish at 1.1905, 1.9564 and 2.5554 seconds.
publication refuses `canonical grapheme exceeds publication capacity` at
5.0763 seconds; derived preparation never starts. sampled JVM heap peaks at
188,829,800 bytes and owned files at 202,333,325 bytes. that measures only
the accepted source and bounded failed partition attempt. it establishes no
cost for decoding, shaping or selecting the hypothetical complete unit.

## existing-schema complete unit

this is the smallest concrete semantic contract: one ordinary publication unit
contains the entire atom and its required source ancestors. its current member
digest, source range, revision, unit lease, and prepared root remain the owners.
there is no second transfer, cache, or retirement protocol. canonical markers
remain original-source facts; the full shaped run remains present while its
existing lease is held.

it requires qualifying the **largest accepted source**, not increasing the
limit to the first witness. both native and hosted currently cap members at
256 kib and units at 65,536 points. the shared reader reserves eleven times the
member size before parsing; account capacity is 32 mib and view capacity is
8 mib. the epub witness alone would reserve about 528 mib; the retained example
about 704 mib. those are conservative admission charges, not measured physical
requirements. lowering their multiplier requires separate peak evidence.

the full bound must include encoded bytes, json decoding, both retained text
representations, canonical source maps, dom text, shaping/copy/selection state,
and cancellation overlap until callbacks release their references. worker and
native preparation also retain normalization state proportional to the atom.
an atom need not inhabit one text node: authored inline elements can divide its
marks. their node and attribute costs remain in scope under the existing source
limits; raising only the point/member caps leaves the 8,192-node cap unresolved.
qualifying a single read does not qualify concurrent account reads, multiple
views, or already pinned units. the existing owners must admit that total or
decline before allocation without claiming accepted-source reading is complete.

for exact member size `w`, current transient admission is `11w`; the proposed
profile must satisfy each view's retained bytes plus `11w`, and the account's
retained bytes plus the sum of admitted concurrent reads. actual process peaks
are a separate oracle. source maxima alone do not give a defensible numeric
bound for browser shaping internals. no existing capacity receipt establishes
one for tens of millions of points.

## paged atom representation

the minimal storage contract would name an atom by publication revision,
fragment, and canonical extent, with immutable ordered parts carrying exact
offsets, source text, and member digests. the existing session would have to own
all parts used by the same continuous prepared root until physical retirement.
cross-part canonical ranges and source identity are representable without
changing the authored text.

this only bounds encoded transfer and parsing of each part. appending every
part to one root still retains the full shaping run and selection text. rendering
parts independently loses the required equivalence. a bounded glyph/selection
projection would require an actual maintained shaping implementation with exact
source mapping and offline availability; none is selected or demonstrated.
storage paging therefore adds wire and assembly work without resolving the
observed final-allocation conflict.

## decision and remaining evidence

prefer the existing-schema complete unit only if an actual maximum-source
experiment can qualify its entire preparation and interactive cost under an
explicit resource profile. otherwise neither option currently establishes the
required bounded, faithful reader. do not activate paged storage as a purported
solution to shaping, silently split the cluster, lower accepted input limits,
or label permanent conversion refusal as support.

the next useful experiment would retain exact admitted source bytes and compare
the same maximum atom's preparation, first paint, selection/copy, cancellation,
and concurrent-view peaks. include nfc expansion and ordering, astral text, and
inline source markers rather than only a repeated acute mark. the current caps
stay unchanged until that contract is chosen. physical handset verification was
waived by the user; host observations must not be reported as handset evidence.
