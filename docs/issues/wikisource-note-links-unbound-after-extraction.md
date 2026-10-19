# wikisource note links remain unbound after extraction

status: open. origin: 2026-10-04 apparatus baseline at `58ba9d45`; area: node article extraction / web reader. priority: p3.

the acquired public `On Liberty/Chapter 2` html (sha256 `3bcb35d49a24c4d12bb91a533d7b09912bc74e1a45290847034f623505f50f3a`) has five `cite_note` targets and five `cite_ref` markers. the actual `extractArticle` result retains five marker ids and seven note hrefs but zero `cite_note` target ids; native web preparation with the original full `source_html` supplied as `embed_source_html` yields zero apparatus items/groups. the exact loss point or classifier cause remains unqualified. this is one source and one local native extraction, not a general wikisource census.

qualify extraction and apparatus target classification together, then retain supported authored note targets without unrelated page chrome. acceptance: this exact source produces linked note bodies through extraction, preparation and a reader apparatus read, with title/main-body text and source order conserved.
