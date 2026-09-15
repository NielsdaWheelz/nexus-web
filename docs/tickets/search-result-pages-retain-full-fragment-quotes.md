# selected search pages still contain full fragment quotes

status: open · origin: 2026-09-15 pr #270 review · area: search memory · oi-135

fragment candidates now contain metadata until pagination. selected public
results still preserve complete fragment text in `text_quote_selector.exact`;
the same text is part of the existing offset/time locator contract. discovery
allows up to50 results and concurrent requests. eliminating discarded candidate
bodies does not establish an absolute response-byte or concurrent-memory bound.

owner: `search/retrievers/fragments.py::read_fragment_search_content` and
`search/projection.py::_result_to_out`. preserve reopening, citations and reader
activation when defining bounded locators or response admission. qualify large
selected fragments and overlapping pages on the existing host before closing.
