# release: connection actions

status: production `99320b630` ran migration `0299` on 2026-10-22 (schema 0306,
wire 13), with the owner's 2026-10-19 approval to delete every existing discovery
suppression. live acceptance remains outstanding.

data effect: `connection_discovery_suppressions` is dropped, including all
preferences. no resource, edge, note, message or assistant receipt is rewritten.
previously dismissed pairs become eligible on subsequent ordinary scans; no bulk
rescan is started. no old dismissal route or schema compatibility reader survives.

after release, verify deployed source identity, then use explicitly scoped
disposable own records to check exact machine removal, both books surviving,
live cross-view settlement and absence of the suppression table. clean up those
records. production mutations require scoped deployment/smoke authority; this
specification does not grant it.

keep this record until live acceptance is complete, with actual observations in
the pr.
