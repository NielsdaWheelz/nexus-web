# reason context narrows below its ellipsis

beside a `.reason`, byline and context share pressure in proportion, so a long byline
can leave context too narrow for one character and an ellipsis. css-overflow clips a
first character rather than ellipsize it, so that box shows a sliver of text and no
whole ellipsis, against "ellipsize individual fields" in
`docs/modules/resource-references.md`.

impact: none on a real surface today. the one real row beside a reason, a search hit
removed under its open results, has no byline. the proportional share is a decided
trade: it keeps context inside the line.

evidence: 2026-11-01 lab case, `resource unavailable` inserted into live rows under the
real compiled css, 11.4px mark. rows with a short byline ellipsize at both viewports.

| row | viewport | line | byline | context | painted |
| --- | --- | --- | --- | --- | --- |
| search, long byline | 362 | 249.4 | 94.8 | 8.9 | `m`, clipped |
| search, long byline | 402 | 289.4 | 131.3 | 12.3 | `m` |

resolved when a reason row with a byline ships and context keeps room for its ellipsis,
or when such a row can no longer exist and this file is deleted.
