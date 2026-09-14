status: open
origin: 2026-09-13 bounded workspace native geometry qualification
area: offline table header context

unactivated `OfflineReadingTableGeometry.kt::intersecting` bounds returned rows
with keyset pages, but its ordinary btree still examines a source-sized prefix
for a tiny late slot. native receipt `792026fe6800d47c` at `d5b330da07` retains
actual sqlite measurements: 16 tiny queries cost 0.077–0.160s at 65,536 cells
and 0.301–0.576s at 262,144 cells. repeating that query for each principal
row/column would multiply the source scan for large spans.

the selected-header event candidate now skips impossible axes and pages group
headers directly (`ffab9e7615993229`), but still rescans active endpoints at
each inner band. actual canonical `acadb25b123d1f06` at `f3df479f1a` observes
1,000/2,000 overlapping headers taking 8.37/17.02 seconds to first page, with
3,001,000/6,002,000 endpoint visits despite only 2,000/4,000 changed unique
cell spans. actual EPUB sanitizer/table projection attests those rectangles
in `48899c7db2a2eae1`; this is far below the existing encoded source envelope.
web sanitization removes scope, tracked separately in oi-162.

the query-private disk interval tree passes `44ae28f4a554d64e`; those first
pages improve to 1.915/3.507 seconds, with 86,760/187,520 node reads instead
of 3m/6m endpoint visits. scratch grows to 393,216/688,128 bytes. maximum
source, repeated selection, physical temp storage and device costs remain
unqualified. this is an improvement, not closure of the latency/activation gate.

the scalar cursor correction plus expanded source proof passes
`31bf96457f77a5a8` at `5608675026`, but 8,000 headers still take 5.624s to
first page (750,744 encoded reader bytes). source index is 1,048,576 bytes,
query scratch 2,580,480 bytes; 852,080 node reads cost 1.624s and interval
state/opacity work 2.807s. late irrelevant 65,536/262,144-cell tables take
46.9/90.8ms despite zero decoded candidates. fixed returned pages alone do
not qualify foreground work.

first finalize the sparse immutable cell/header semantics. choose and measure
one selected-cell association algorithm that merges equivalent geometric events
or uses a justified interval index; do not emit all-cell header associations or
silently reduce the supported source envelope. the exact index is now built and revision-bound before package activation;
its selected-query costs remain a candidate, not a release-qualified budget.

acceptance: exact normative header corpus plus maximum supported encoded-source
shapes (large implied rows, long spans, overlaps/gaps, groups, many headers),
bounded retained pages/heap and measured query work/time. attested members and
revision-bound derived files must retain separate closure/accounting under the
existing package installation owner. the user waived physical-handset verification;
host qualification remains required and must not claim device evidence.

latest cursor-reuse receipt `8403e63be75bbca7` at `7dbba0b272` improves the
same 8,000-header case to 3.742 seconds, still unqualified. current production
source has no caller of `OfflineReadingTableHeaders`; its only consumers are
host proofs. installed-index activation is implemented, but the bounded query
must also be integrated with the actual reader/lease before this feature is done.


2026-09-14 hosted-design review: `OfflineReadingTableHeaders` retains the
query database between `page()` calls; its key does not reconstruct ray state
without the retained result. only group-header phases directly keyset immutable
source. the class comment calling interval state source-sized is stronger than
the demonstrated bound; no proven maximum state/work bound replaces the 8k
receipt above.

source inspection predicts another adversarial workload, not yet passed through
the actual producer or measured: one tbody's first row has m adjacent
`<th scope="row" rowspan="0">far</th>`, one ordinary gap td, a near row header
with rowspan=0, then the principal td with rowspan=0. append n rows alternating
`<tr><td colspan="2">block</td></tr>` and `<tr></tr>`. the row-spanning far
headers occupy the earlier columns, so each later td anchors at the gap and
overlaps only the near header. all headers share the exact orthogonal group.
nearest unique-header coordinates alternate across rows; each farther header
walks that same fragmented first-header partition in `header()` and repeatedly
updates its one deduplicated result. this predicts omega(m*n) reduction work from
O(m+n) source cells despite colspan<=2; it does not require quadratic retained
state. qualify this source recipe before claiming the colspan ceiling bounds
whole selected-query work. preserve normative overlap and opacity semantics.
