# release collection loading

status: implemented; final qualification and paired release are pending.

the approved collection-loading cutover changes podcast preview from a pageable
response to a bounded directory snapshot. `GET /browse/preview` accepts only
`target`; episode output becomes `{items, source_limit: 1000}`. the existing
`limit`, `cursor` and episode `next_cursor` contract is removed. saved-episode
pagination is unchanged. external browse candidates also move their sealed target
to the candidate itself; `PreviewResolution` carries only its kind. candidate
identity now survives acquisition into an owned resolution. no database migration
is planned.

before release:

- qualify the collection contract in architecture section 8.12 and the affected
  module docs; generate wire types from the backend schema and pass
  `./scripts/test`.
- retain `WIRE_REVISION = 13`: preceding unreleased breaks already advanced
  the checkout beyond the actual deployed wire 11. read-only host inspection on
  2026-10-21 found `/var/lib/nexus/releases/current`, the api container's OCI
  revision, and its imported edge revision at
  `8a67e218ae28cedf89932d7feb13d5cffea05c60`, wire 11. the contrary 10-19 records
  are corrected. pair api/web and all shipped
  wire clients, including matching extension/native apk artifacts; identify any
  client not deployed. verify rejection against deployed 11, not a prerelease
  sharing 13. android firefox qualification does not establish native apk
  compatibility.
- qualify the provider's documented `max=1000` request with explicit credentials;
  fixture results alone do not establish provider compatibility. preview must
  state its source bound and create no acquisition state.
- qualify loading and refresh on android firefox using the bookening (316
  episodes at specification time) and all (554 entries). record actual counts,
  timings, request behavior and limitations in the pr; do not add a hidden cap.

resolved when: the paired release serves the target-only bounded preview and
universal collection loading, rejects old clients correctly, and the agreed
provider/device journeys have passed. this record authorizes no deployment.
