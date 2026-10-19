# epub contents union overpromotes source headings

status: open
origin: 2026-09-26 chapter-detection council; local four-book inspection
area: epub structure / reader navigation

the pre-change `epub_structure.py` unconditionally added headings not matched to
a publisher target; `epub_read.py` added them to contents.
in local shadow & claw (`sha256:5e89f049ae8dd00b29053ed588e27e4d0ae5852225a96ab164827f90563ce0d3`),
75 published toc entries produce 149 sections. chapter numbers and titles are
separate h1 elements; e.g. `OEBPS/xhtml/chapter1.xhtml` has `I` and
`resurrection and death`, while its publisher entry already combines them.
in the pillow book (`sha256:8f625aa3c9f1fd0084e1c014fc27a390f3d278bc1f50519a0272ebef7a60e88f`),
225 subordinate headings in `OEBPS/html/notes.html` become sections. the same
book has 297 useful inferred numbered primary entries that must survive repair.

prerequisite: define routine reading sections separately from complete published
navigation and auxiliary detail. fix the structure owner's blanket union;
supplement authored navigation only for evidenced missing reading structure.
retain original targets and access to published contents. no title blacklist,
file-count heuristic, or macbook-only filtering.

acceptance: one stop per wolfe chapter title group, preserved pillow numbered
entries, notes accessible without each commentary heading entering routine
navigation, and consistent shared controls. counts alone are insufficient.

research source at `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`;
relevant extraction owners match production backend `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`.
production book bytes were not inspected.

2026-09-26 implementation update: the exact local wolfe import now has one
`I. Resurrection and Death` section at `chapter1.xhtml#ch1`; pillow's 225 note
commentary headings are auxiliary, and all 297 numbered primary entries survive.
the final pillow row `01a0e083-1616-7297-a884-da157a28930d` has 334 sections,
including 37 non-numbered stops. some source-only frontmatter headings still look
decorative or editorial: `THE PILLOW BOOK` at fragment 3 offsets 0 and 685,
`Translated with Notes by MEREDITH MCKINNEY` at 702, `PENGUIN BOOKS` at 746,
and the chronology explanatory sentence at 2143. other source-only introduction
subheads may be legitimate divisions. the current parser lacks decisive evidence
to remove the ambiguous rows without suppressing real authored structure.

remaining acceptance: establish source-role evidence for the decorative rows and
remove only proven non-reading boundaries; keep 297 numbered entries, legitimate
introduction subsections and all published destinations. no title-specific rule.
