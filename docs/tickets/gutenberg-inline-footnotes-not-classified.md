# gutenberg inline footnotes are not classified

status: open. origin: 2026-10-04 apparatus baseline at `58ba9d45`; area: epub apparatus extraction. priority: p3.

the official `pg34901.epub` (sha256 `40f82f6fd2e6a4c2ab7a9ed248ab40840feb4cdc652dc56c1d6e468a9e165ab6`) has 14 `FNanchor_`/`Footnote_` marker/body pairs across two spine files. native bounded full `_build_plan` succeeds with four fragments but zero apparatus items/groups. its plain `<a class="fnanchor">[n]</a>` markers are outside the current semantic and superscript-only inferred marker cases in `html_apparatus.py:_classify`; the local parser run did not publish them as reader notes. this establishes behavior on one archive, not a prevalence or capacity claim.

qualify its reciprocal marker/target semantics and classify supported note links at the extraction owner without promoting ordinary numeric links. acceptance: the same full archive yields linked note items, stable source order and accurate reader locators while non-note numeric links remain unclassified.
