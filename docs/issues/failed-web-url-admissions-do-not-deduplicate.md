# historical duplicate ordinary imports

older admissions could create several failed media for one ordinary url before
canonical publication. these rows can still exist; automatic merging is outside
browser recovery because their filing and histories are independent.

new admission in `python/nexus/services/media_source_ingest.py::_accept_url`
checks owned retained original identity before global canonical reuse. one
settled target is reused with its current provenance; active work refuses a new
admission id. several targets return `E_SOURCE_TARGET_AMBIGUOUS` without filing.
the extension requires an explicit choice among eligible failed targets.

reproduce the remaining condition with historical duplicate retained rows:
re-add their original url, then inspect the recovery picker. no new duplicate
should be created. owner-selected removal resolves individual duplicates;
general merging requires a separate identity/filing/history design.

resolved when the owner has disposed of affected historical duplicates or
explicitly accepts retaining them. no bulk cleanup is authorized.
