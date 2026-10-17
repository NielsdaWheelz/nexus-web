# declared epub 3 source loses its ncx contents in repair

status: deferred future work; excluded from this campaign’s apply selection
origin: 2026-10-14 retained-book clone source review
area: epub navigation source selection

three sources declare opf version 3.0 and supply ncx contents without a declared
nav document. selecting the nav parser from the declared version loses authored
contents:

| media | original ncx / retained toc | proposed toc |
| --- | --- | --- |
| `748f7d1c-05dc-4937-b604-695b98f6a9a4` | 16 | 0 |
| `afec0538-875f-4709-b168-20e25f244820` | 133 | 8 inferred rows |
| `eaccf598-d00e-424d-a666-c20c777aae9c` | 47 | 0 |

successful inspection and zero removed apparatus identities do not make this
proposal safe to apply.

private source evidence under `book-repair/b-reader/navigation-exceptions-source-v1/`:
`navigation748f7d1c-source-v1`, `navigationafec0538-source-v1` and
`navigationeaccf598-source-v1`. the first `output/source-evidence.json` sha256
`48867ef873a08b9c7bc383ca10211ec14b4794e7c5be99d5eb66b3505f9b6a59`.
source hash, installed projection and clone generation matched during the
read-only proofs. all four probe pids (including a separate opf1 case) are
absent in `coordinator/navigation-four-source-backend-reconciliation.json`.
final global equality passed across all 96 tables. independent content review
confirmed all three exclusions: `a-maintenance/navigation-exceptions-content-review.json`,
sha256 `24250060b692d95306ae932f33c2e236e4b924a3effaef8eed136fbe9be87f80`.

prerequisite: review original package/navigation semantics before choosing any
parser policy change. retain these books' installed navigation in this campaign;
do not introduce a book-specific override or repair by accepting the loss.

acceptance: a separately reviewed source-owner change produces corrected,
source-verified repairs preserving authored destinations/order/hierarchy, or a
source-proved no-change outcome for each exact id. a refusal alone does not
complete this future work.
prove the resulting proposals against the original sources and current reader
consumers before changing their unresolved dispositions.
