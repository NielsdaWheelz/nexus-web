# retained epub text can reorder an authored inline phrase

status: open
origin: 2026-09-27 source-note integration review, pr #398
area: epub / retained reader content

restored-clone item 101 (`e6b755eb-c744-4391-b6ec-2b3ed2553837`, source
sha256 `01c64cceac36df2ee70ea4a1be0696a1bed2fd27e2f70f736ab7c33cc5e9c597`),
fragment 148, has an authored note whose installed plain body matches the source
(sha256 `af4bee89fd9e28693e221c630c3e537e2336db05cf544ce95482f0a3f14e5fc0`).
the retained reading html yields a different 353-character body (sha256
`b9b7dff084862397d4baf00999b42abc154c15ae4ead1def42c51de2fe8bf7b7`):
`I AM THE EXISTING ONE.` moves from the middle to the end. the target anchor
remains at offset 0. a repair that enriches from retained html would change the
note's wording/order; a blanket reimport could change saved reader positions.
item 102 has a different early canonical-text drift, but its eleven sampled
note targets retain the same body text and marker offsets.

prerequisite: inspect the exact original source and retained fragments, plus
saved positions and apparatus dependents. repair the sanitizer or use a fenced
publication migration that preserves identities and remaps positions exactly.
until then, source-authored note bodies must not be replaced by reordered
retained text.

acceptance: the reader and note evidence preserve authored order, and exact
source, fragment, apparatus and saved-position checks pass after repair.
