# public source url: the arxiv provider-ref arm never matches

status: open, source-qualified.
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: resource sharing / public source urls.

`python/nexus/services/public_source_urls.py:47-56` builds
`https://arxiv.org/abs/{ref}` from a non-empty `provider_target_ref` and asks
`_arxiv_abs_url` (`:66-68`), which only recognizes `/pdf/<id>` urls
(`remote_file.arxiv_pdf_id`). the ref arm therefore always yields `None`, and
`_agreed` refuses any identity list holding `None`: an arxiv attempt that
carries a ref never discloses its source url.

fix: compare the ref itself with the ids the urls yield (`arxiv_pdf_id(url)`),
or build the ref url as `/pdf/{ref}`.

acceptance: a shared arxiv pdf whose attempt carries `provider_target_ref`
discloses `https://arxiv.org/abs/<id>`.
