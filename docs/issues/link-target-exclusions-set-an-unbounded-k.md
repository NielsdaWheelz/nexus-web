# link-target exclusions set an unbounded ranking depth

status: deferred · origin: 2026-10-10 search reauthor review (cleanup/search-reauthor, finding 2's sibling) · area: search / link picker

`search/pickers.py::_targets` ranks every link family to `k = 2·needed + |excluded|`,
and `schemas/resource_search.py::ResourceTargetSearchRequest.exclude_refs` has no
length bound (neither had the pre-reauthor request). a request with a very long
`exclude_refs` list makes each family return every match into python, as an unbounded
`/search` cursor offset did before `query.MAX_OFFSET`. the web sends only the source's
existing links, so no current client gets near it; the cost is the api's memory margin
(`api-reader-search-memory-margin-remains-small.md`).

fix: bound `exclude_refs` (`max_length`) at a size above any real source's link count,
or count only exclusions that fall inside the ranked prefix.
acceptance: a targets request with an oversized `exclude_refs` is refused, or its
families rank to a bounded `k`.
