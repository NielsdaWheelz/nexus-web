# heading coalescence removes bounded divisions without a replacement extent

status: open; both whole-book proposals unsafe, not applied
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

`python/nexus/services/epub_structure.py:151` matches publisher headings;
lines 271–284 coalesce matching/claimed headings before final extents exist.
`reader_structure.py:118–129` then rejects children outside their parent bound.
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

fix the section owner so coalescence preserves a source-proved reading division
and its extent. resolve the actual parent/title boundaries before retiring its
only bounded representation; do not fabricate an end, copy a questionable old
end, or reparent solely to satisfy clipping. the two real source shapes need
separate boundary proofs, not a broader permissive heading matcher.

acceptance: all three divisions retain independently addressable, source-proved
extents after coalescence, or the repair explicitly refuses them. verify complete
projections and reader extents before applying either book. this shared owner
repair is outside the bounded maintenance campaign.
