# reciprocal backlinks create reversed note pairs

status: open; both unsafe proposals remain unapplied
origin: 2026-10-15 retained-book rehearsal, candidate `150328b65`
area: epub apparatus / reciprocal link roles

media `44218cdb-014a-44ec-aaf2-300dbb2a4773` and
`7db2fb1e-cbb1-415a-b994-0963866ec1c9` share verified original
`e999129851463577eac57ad31543da9aa56d1e264ac1d6bfc82a81195ab11943`
(1,892,370 bytes). its authored roles are distinct:

- `text/part0025_split_002.html`: `bck_fn12_2` and `bck_fn12_3` are
  inline superscript references inside one reading paragraph;
- `text/part0025_split_008.html`: an explicit notes heading contains separate
  `p.footnote` bodies at `fn12_2` and `fn12_3`, each with a return link.

both proposals add the correct reference-to-note pairs, with separate 45- and
32-character note bodies, alongside false reversed duplicates: the note-return
anchors become `footnote_ref` items; the inline references become `footnote`
targets with the same 658-character reading paragraph as their body. both
false targets inherit its leading `2.` label. changing that label or splitting
the reading paragraph would conceal the classification defect. installed state
has neither direction for these two pairs and stays unchanged.

the shared extraction path is `html_apparatus.py:614–681`
(`collect_html_apparatus_targets`). the false number 2 target reports
`html_note_boundary`; number 3 reports `html_link_graph` inference.
`_untyped_note_body` at 1451–1468 and `_looks_like_note_body` at 1564–1579
mistake the reading paragraph's leading number for a note marker;
`_classify` at 1328–1361 admits the opposite note-return anchors as references.
these paths are under `python/nexus/services/` in candidate `150328b65`.
the repair publishes the resulting source projection; it must not add a
book-specific exception.

private evidence under `book-repair/`:

- source facts: `b-reader/shared-e999-source-packet-v1/receipt.json`, sha256
  `c4968d55909aa445eed824b0ce7216c8ac7ec787f95e424edada4932423da01f`;
- independent roles: `a-maintenance/shared-e999-role-independent-review.json`,
  sha256 `098585c6fcac6836cdb764377f12d6f53f50c2786bbd9adf160c539c038d6be4`;
- installed/proposed directions: `b-reader/shared-e999-role-proof-v1.json`,
  sha256 `b7fa37939c4d60837214a5f03e898f443216deae1023fc3fbf4ca49fe2593d59`.

the earlier label-only interpretation `beeec3e6` assumed the target's semantic
role. it is retained and superseded by
`a-maintenance/shared-e999-label-interpretation-withdrawal.json`; it is not the
final refusal rationale.

next: correct reciprocal-pair role classification at the shared source owner.
prove authored note ownership before admitting inferred targets; preserve
existing identities. qualify normal ingestion and the full repair proposals.

acceptance: inline references lead to their actual note bodies and return links
lead back; the reversed duplicate pairs are absent. labels, complete bodies,
retained coordinates and existing identities all pass source review before
either whole-book repair. unresolved campaign dispositions do not close this defect.
