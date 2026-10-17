# heading coalescence removes bounded divisions without a valid replacement extent

status: open; five historical whole-book proposals unsafe; none applied
origin: 2026-10-15 book-repair retained-source review, operator `150328b65`
area: epub section coalescence and semantic extents

two proposals retire existing bounded heading divisions while their surviving
publisher sections still have absent ends:

- `dffd5b19-d5c0-4768-80ff-266b7797d596`: two title divisions at `10:4` and
  `11:5` disappear. the retained first chapter has a three-heading title that
  `_matching_heading` declines. its unmatched roots close the publisher part
  before the later chapters, whose extents remain absent. the old title ends
  are not established as ideal authored boundaries; losing their independent
  bounded divisions still needs a proved replacement.
- `bf8ccea7-e2e8-4eea-bc2f-188874677302`: chapter 24 loses its independent
  `30:0–30:6746` heading range. the source's `CODA` prefix precedes the parent
  heading, so its publisher point does not match that heading. the inherited
  parent end precedes chapter 24; its surviving publisher extent stays absent.
  a separately expanded coda heading preserves overall text coverage, not
  chapter 24's independent extent.

`15d9b33d-f13c-4542-969c-2ab74d5c3659` loses 31 independently bounded
chapter divisions. each retired heading exactly spans its complete retained
source `section` container, from its unique opening chapter heading to the
container's canonical text end. the sole surviving same-point publisher
chapter still has an absent end. neither the unchanged title destination nor
a broader volume range preserves that chapter interval. the old parent
choices and ideal volume boundaries remain unadjudicated; this refusal does
not depend on the separate, locally successful 30-note source proof.

the historical proposal for `2c4eb378-a571-4cae-a9f0-cdfaea9768f5`
similarly removes the three independently bounded chapters 2–4 at
`11:0–12:0`, `12:0–13:0`, and `13:0–14:0`. their retained source headings
name consecutive chapters, followed by `Synopsis`; each chapter contains
substantial prose. the sole surviving same-point publisher chapter still
has no end. the composite part-two/chapter-one heading and inherited work
bounds do not replace these individual chapter intervals. those other
scopes remain unadjudicated. independent review confirms this fixed failure.

an additional case, `898b1816-2b0e-4e85-9027-9c629be025d5`, replaces bounded
divisions with explicit but false eof scopes. the retained source has separate
`CHAPTER I.` and `CHAPTER II.` h1s inside `BOOK FIRST.`. chapter one's heading
and title currently end at the next chapter, `12:0`. the candidate retires
that heading and extends both surviving chapter representations to book eof,
`70:19666`. it also replaces the bounded foreword heading and extends the
foreword from `7:0–9:0` through the whole work, bibliography and index.

the old publisher hierarchy already places chapter two under chapter one's
title and chains later divisions beneath earlier ones. that inherited state
is not endorsed or attributed to an unexamined original ncx. retiring the
independent heading boundaries makes its effect worse: the newly resolved
ranges assert coverage across explicit peer chapters. a merely present end
is therefore insufficient to preserve the retired reading division.

`python/nexus/services/epub_structure.py:151` matches publisher headings;
lines 271–284 coalesce matching/claimed headings before final extents exist.
`reader_structure.py:118–129` then rejects children outside their parent bound.
in the additional case, depth-based closure at lines 103–107 instead carries
the inherited ancestry to eof after the independent heading roots disappear.
the retained markup and complete candidate projections prove the interaction.
stored text remains intact. original ncx files were not acquired; no api,
browser or device failure was executed. other proposed changes are unadjudicated.

private evidence under the campaign directory:

- `c-sources/navigation-dffd-three-heading-facts-v1.json`, sha256
  `3fe68d228d7fc8124edd488bd68f4fc2dac607e06d0f71455bf2f4dba3abed10`;
  full proposal `71855f1c38c2cdc78fd7f317bb3119bb5d91bf5749703eda2c708230eaad7c21`.
- `c-sources/navigation-bf8-coda-boundary-facts-v1.json`, sha256
  `e8f9c3272292075a8f88afdf74e146c7bee5e56576fd0b0a58454a9ce07282ff`;
  full proposal `7eaf38dbf0fb65f1a967208416460b1890a050d4d3b8e360fc47c919c11a4042`.
- independent review `b-reader/navigation-dffd-bf8-independent-review.json`,
  sha256 `9670dc24333435d579ed4504dffed9267d015859f4fa2b0ed52bcd44118d1831`.
- `b-reader/thirtyone-chapter-scope-loss-review-v1.json`, sha256
  `d560517a8c2f3c1ba01805b9986de066cc0e3845dad4be91343832951051b340`;
  source `bba86af36ab2a3062dacd928c7fd7592c88c8c8072993cbcd4cca52c3ac728b4`;
  proposal file `ac92954f06b1448c058bf23d25b17688926b83c253a821fbc843ec704ded3e78`;
  full proposed metadata
  `c28dc1f1a8349f8b7f341308cd054e291d0498ed1337caee76cc814012672b2f`.
  independent review
  `a-maintenance/thirtyone-chapter-scope-loss-independent-review.json`,
  sha256 `0a8460697455661c4a09996aa95ba28f1a38694bd7549171d5b8e38b643dbe6d`,
  reparses all 31 retained chapter containers and reconstructs the complete
  projection. the failed positive proof remains preserved; no original
  chapter acquisition or consumer execution was needed for this refusal.
- `a-maintenance/navigation2-scope-failures-v1.json`, sha256
  `c232f5acb6e3155ff57b2c25b8760741f24f3982163fcb533323ddf9b722b940`,
  binds six retained documents and the complete `2c4eb378` projection;
  source `315685bc5fa99640adae867db2c8423b00f38a6b0eddbafd4e48ab2e4e013f41`;
  proposal file `7c0c44abcd861f8f2c2eb594369446c8120483d4e6a1f3d1caf6d2cbe5ecaa01`;
  full proposed metadata
  `28167191cc8b44b3939368428284b49ef6c1d63485c3700834705a3d1b63e688`.
  this is evidence against the frozen `150328b65` proposal, not a claim that
  the newly integrated stack has reproduced it.
  independent review `c-sources/a-two-scope-failures-independent-review.json`,
  sha256 `3e3bbc25464eb5fba69c74408dd4c0a5af9135e8ac818ef98616fbb53356fed8`,
  rebinds the complete proposal and reparses all six retained contexts.
- additional source/full-projection evidence
  `c-sources/navigation-ancient-city-scope-review-v1.json`, sha256
  `4e5e7b2f505cd6f623ddff3a7a854639072442abfafafb113b63bfe816de377c`;
  source `ed76283b57fcbdb94d3bf26a13e258b6c6d6445745715f9f2467947a825ca37b`;
  full proposal `f83b9d4a15989d4b34f8773d52aa83288ab396d66ad80d8cdf1cbc3493b7cd89`.
  eight exact retained fragments bind the foreword, introduction, numbered
  books/chapters, bibliography and index. independent review
  `a-maintenance/ancient-city-scope-independent-review.json`, sha256
  `2b4194de11e020069705fdc954827990f340ca5618d0597837f6488573756e47`,
  confirms the newly false scopes and preserves the inherited-hierarchy limits.

fix the section owner so coalescence preserves a source-proved reading division
and its extent. resolve the actual parent/title boundaries before retiring its
only bounded representation; do not fabricate an end, copy a questionable old
end, or reparent solely to satisfy clipping. these real source shapes need
separate boundary proofs, not a broader permissive heading matcher.

acceptance: the affected divisions retain independently addressable,
source-proved extents after coalescence, or the repair explicitly refuses them.
in the additional case, the foreword and chapter one must not acquire later
peer divisions through inherited ancestry. verify complete projections and
reader extents before applying these books. this shared owner repair is
outside the bounded maintenance campaign.
