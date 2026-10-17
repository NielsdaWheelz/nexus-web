# authored navigation targets have no retained reader unit

status: open; separate reader capability work, no passing jump claim
origin: 2026-10-17 book57 full original-navigation audit
area: epub navigation / retained content

six authored destinations exist in their original archive but have no retained
fragment. metadata repair must preserve their links as unresolved and report
source issues; it cannot invent reader coordinates or rewrite retained content.

- `2c4eb378-a571-4cae-a9f0-cdfaea9768f5`: contents Cover and guide Start Here
  target image-only `OEBPS/xhtml/01_cover.html`.
- `a0b16180-2833-4854-8ceb-d3763884e096`: guide Cover, ThumbImageStandard and
  PPCThumbnailImage target `OEBPS/9780575098367_msr_{cvi,cvt,ppl}_r1.jpg`.
- `dffd5b19-d5c0-4768-80ff-266b7797d596`: guide Table of Contents targets
  `OEBPS/text/nav.xhtml`, outside the retained spine.

evidence: campaign `coordinator/followup57-20261016/source-navigation-source-gaps.json`
binds the exact original hashes, authored entries and retained inventory. no source
is missing and no source correction is authorized by this record.

next: define an explicit reader destination for these asset/nonspine resources
before changing publication behavior. preserve original source, existing fragment
identities and saved positions. this is outside the book57 metadata repair.

acceptance: each destination reaches its proved authored resource through the
ordinary web/phone reader with publication identity preserved; otherwise retain
its unresolved state and avoid a passing jump claim.
