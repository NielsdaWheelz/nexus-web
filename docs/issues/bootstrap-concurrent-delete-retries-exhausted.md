# first-auth bootstrap contends with itself

concurrent first authenticated requests can exhaust bootstrap's three serializable
attempts. this predates the capture change: `bootstrap.py` is unchanged between
`c11f07e49` and `c732fb082`, and its last change is `2cacaa3c2`. do not increase the
retry budget or suppress the failure.

exact evidence from disposable run `20261028-134420-6a4efbdf61f6`:

- `api.log:59-60`, request `8ffd83eb-f8ac-4426-b299-bc167c5daccb`,
  `GET /me/workspace-session`: `default_library_bootstrap exhausted after 3
  transaction attempts`, returned 409 (not 500). the failing statement was
  `DELETE FROM keyword_occurrences WHERE doc_key=ANY(...)`, key
  `library:2edb5666-1b58-43c0-b5e5-08c05d75f339`.
- `containers.log:8747-8756`: at 20:45:12.295, backend 152 first lost an
  `INSERT INTO users` race; backends 148/147 failed projection deletes at .301,
  and backend 152 failed another projection delete at .309. same burst's
  `/me` and `/me/reader-profile` succeeded at .300984/.305972 for new account
  `6d083428-d53b-44d8-9e42-8b9aa77efc7d` (`api.log:57-58`).
- `api.log:49`: media deletion finished at 20:45:07.276129 under different
  account `e051d4ae-8551-49b9-8e29-96d01486965e`; it cannot explain the new
  account's default-library key. no library mutation request occurs in the
  first-auth burst.

`auth/middleware.py:97-112` checks `_seen` before awaiting bootstrap without
coalescing concurrent requests. `services/bootstrap.py:24-34` checks ready state
only before entering retries; each slow-path attempt unconditionally calls
`projection.refresh(..., 'library', ...)` at line 66, even after a competing
bootstrap completed everything. `search/projection.py:350,393` deletes/reinserts
that library's keyword row. ordinary bootstrap requests therefore delete one
another's projection rows; this is not capture-media teardown. logs do not attach
request ids to successful postgres statements, so the individual successful
backend/request pairing is inferred from this closed writer path and burst.

reproduce with a fresh real auth account and simultaneous initial `/me`,
`/me/reader-profile`, `/me/workspace-session` requests before middleware records
it as seen. use actual auth/database/projection, no source acquisition required.
fix bootstrap's ownership of its ready-state transition: re-read the complete
ready state inside each owned attempt before repeating repair/projection writes,
or establish equivalent serialization at that boundary. keep cross-account email
transfer semantics. resolve when the concurrent requests all return their correct
account/default library, no duplicate memberships or projection rows arise, and
bootstrap does not rewrite an already-completed first sight. qualify separately
from x capture implementation.
