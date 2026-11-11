# the original sonnet author extraction remains unexplained

ordinary metadata correction fixed sonnets 73, 116 and 130 on 2026-11-05 at
`191ae4461`/schema 0335. author-role credited name and contributor identity
became “william shakespeare”, with `web_search: not_available`. committed jobs:

- 116: `01a1acfa-33a6-796d-9ffb-17df6b42bd72`, 18:31:30 utc.
- 130: `01a1acfa-473f-7bef-8baa-4103ee8de5df`, 18:32:22 utc.
- 73: `01a1acfa-5a73-77df-be60-b021e7b32d75`, 18:33:15 utc.

the remaining issue is provenance. the 2026-11-04 production inspection at
`e505409d1` found the placeholder “author” on
`01a18f8a-1f69-7115-8bcd-03f6ac9291ba`,
`01a17ed4-1542-7fc4-a895-970361204d30` and
`01a17ed4-52f1-73fa-80d0-82966d507b60`.
at `b115cbce7`, `python/nexus/services/web_article.py:433` accepted nonempty
extracted bylines; that is a possible path, not established origin for these captures.

inspect original markup and extraction facts before changing the adapter.
do not blacklist “author”, infer a person from title-specific rules or rename a
shared placeholder contributor. close when the original extraction is explained
and any demonstrated adapter defect is fixed. the three corrected credits do
not establish that cause or restore [public search](brave-search-payment-required.md).
