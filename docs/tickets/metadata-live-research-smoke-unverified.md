# metadata live research smoke remains unverified

status: open
origin: 2026-09-14 original-publication-date implementation
area: metadata verification

`python/tests/service/test_metadata_generation.py::test_metadata_registry_worker_binds_research_accepts_unknown_dates_and_replays` exercises the production
worker through a controlled codex peer. the date fixtures prove acceptance and
publication, not the live model's historical judgment or external query choices.
no hosted metadata smoke was run in this change. the approved cutover's
acceptance 4 calls for inspecting untrusted instructions and external queries as
model behavior.

prerequisite: a configured live metadata runtime and brave search, using public
sample documents and an explicit small cost ceiling. inspect a few original /
edition resolutions and actual query contents, including an untrusted passage.
use the ordinary ingestion/retry path; no benchmark framework or production
library rewrite is needed.

acceptance: record the runtime revision, sample inputs, dates, observed web
requests, and any failures. do not describe scope enforcement as query-content
confidentiality or claim general historical accuracy from the smoke.
