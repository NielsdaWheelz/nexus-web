# the committed schema-2 corpus has no producer-agreement assertion

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: cross-language corpus / fixture provenance

## what is wrong

the `retained-*-schema-2` archives are repo-authored wire literals assembled and
verified by the real packager, and `testdata/manifest.json` describes them as
"actual schema-2 producer" output. correcting those source strings is registry
work and is in flight. what has no owner is the assertion that would make the
claim testable either way:

- nothing asserts that the **real producer path** and the committed corpus agree
  in shape. `python/tests/service/test_reader_publication_ownership.py::test_real_file_sources_produce_native_schema_two_fixtures`
  should gain a source exercising a table, a captured asset and an embed, and
  assert that its produced member-key spelling, `table_metadata` record shape and
  canonical offsets match the committed corpus's **shape** (not its digests, which
  would make the assertion brittle without making it stronger).
- fixture-producing proofs write their artifacts to `tmp_path`
  (`test_reader_publication_ownership.py:206`), so committed cross-language bytes
  can go stale with no red. the failure message must carry the regeneration
  command.
- the table cost characterization at
  `python/tests/service/test_reader_publication_tables.py:260` writes outside
  `NEXUS_TEST_RESULTS_DIR`, so the receipt the dossier cites is not reproducible
  from a run.

do not claim the producer path is otherwise unproved — it is; the gap is
agreement with the committed bytes.

## prerequisites

none.

## proposed fix

add the one producer-agreement assertion per committed corpus (decoded member
set, member keys, canonical text — not zip digests), with the regeneration
command in the failure message, and route the table characterization to
`NEXUS_TEST_RESULTS_DIR`.

## acceptance

changing the producer's member-key spelling or `table_metadata` shape reddens the
agreement assertion, and the table characterization receipt is reproducible from
a run directory.
