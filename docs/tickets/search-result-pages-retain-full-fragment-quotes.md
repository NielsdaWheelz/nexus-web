# selected search pages still contain full fragment quotes

status: open · origin: 2026-09-15 pr #270 review · area: search memory · oi-135

fragment candidates now contain metadata until pagination. selected public
results still preserve complete fragment text in `text_quote_selector.exact`;
the same text is part of the existing offset/time locator contract. discovery
allows up to50 results and concurrent requests. eliminating discarded candidate
bodies does not establish an absolute response-byte or concurrent-memory bound.

owner: the `fragment` family's locator in `search/sources.py` and
`search/project.py::project` (the 2026-10-10 search reauthor kept the whole-fragment
locator; a page still projects at most `limit` rows). preserve reopening, citations and reader
activation when defining bounded locators or response admission. qualify large
selected fragments and overlapping pages on the existing host before closing.
