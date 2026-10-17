# ncx navigation selection drops authored landmarks

status: open; two unsafe whole-book proposals remain unapplied
origin: 2026-10-15 retained-book rehearsal, candidate `150328b65`
area: epub source navigation / independent package roles

media `211dd5d1-1d8f-43f8-b48c-92fb089a8671` has resolved cover and contents
landmarks. both roles are independently authored in its epub2 opf guide and
supplemental navigation document. the proposed repair retains the authoritative
ncx contents but deletes both landmarks. choosing a contents authority does not
supersede the package's separate landmark roles.

media `a632754f-6646-4a8f-a36c-0c5ba3decc00` has the same loss. its actual
opf declares version `1.0`; its guide and supplemental navigation both author
cover and contents roles. the proposed 230 contents rows omit both landmarks.

[opf 2.0.1 section 2.6](https://idpf.org/epub/20/spec/OPF_2.0_latest.htm#Section2.6)
defines these guide roles but leaves their use optional for reading systems.
the refusal follows this repair's source-preservation contract; it is not a
claim that omitting guide support violates epub conformance.

`python/nexus/services/epub_ingest.py:2015` selects ncx alone for non-3 packages;
`_parse_ncx_toc` at 2164 emits only contents nodes. compose the authoritative
contents and independent package roles at this source owner. do not add an
epub-version fallback, retain unproved legacy rows, or special-case this book.

`MediaNavigationOut.landmarks` exposes the loss. the current unified reader
does not display that list; no vanished user-interface control is claimed.
the `211dd5d1` proposal also makes an image-only cover a routine section. its reading-
division treatment needs separate review at `epub_structure`, not a filename
or label blacklist; landmark loss alone already refuses this whole proposal.

private evidence under `book-repair/`:

- `b-reader/navigation211-semantic-disposition-v1.json`, sha256
  `60a0731a5ec3ea43fa3482ff696ce30554706908c1eaaaa11a9f5f0783b3dbd1`;
- `c-sources/navigation211-semantic-independent-review.json`;
- exact proposal `6333d66549b3e4f1ae4f920fb1552f323245861ee376698100a563e49b0b8153`.

the second case is bound by
`b-reader/navigationa632-semantic-disposition-v1.json`, sha256
`87739ac429f2f69632435f9116d580005a7a82d619113e42905a43568ab2d5c9`,
and independent review
`c-sources/navigationa632-semantic-independent-review.json`, sha256
`5d625f88088f6616ec3cd1620ce711b6dcf315cc68d65d63c5b47b6c83b16ac4`.
its exact proposal is
`3e32bdb9db242c4b5dcd828cd28c78c4dedc99c5bddc1e830c88dc39d59a4852`.

the earlier source-authority and complete-projection proofs remain valid within
their narrower scope. they did not prove that removing these roles was sound.

acceptance: normal ingestion and maintenance preserve source-proved package
landmarks alongside the selected contents authority, with exact destinations.
qualify each complete proposal and its consumers before applying either book.
