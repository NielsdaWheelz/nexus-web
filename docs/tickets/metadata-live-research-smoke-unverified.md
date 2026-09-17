# metadata live research remains unverified

status: open
origin: 2026-09-14 original-publication-date implementation; updated 2026-09-17
area: metadata verification

the original implementation checked date acceptance/publication with a controlled
codex peer. it did not inspect the live model's historical judgments or actual
external query contents. local inspection on 2026-09-14 found no brave search
key or configured/default codex host socket. the removed tests do not establish
that live behavior.

prerequisite: a configured metadata runtime and brave search, using public
sample documents and an explicit small cost ceiling. inspect a few original /
edition resolutions and actual query contents, including an untrusted passage,
through ordinary ingestion/retry. no benchmark framework or library rewrite is
needed.

acceptance: record the runtime revision, sample inputs, dates, observed web
requests, and failures. do not describe scope enforcement as query-content
confidentiality or claim general historical accuracy from this manual check.
