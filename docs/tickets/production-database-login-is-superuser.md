# production database login is a superuser

status: open; outside retained-book repair
origin: 2026-10-16 book coordinator capability census
area: database / runtime privilege

production's application, workers and maintenance writer still use `nexus`,
which has superuser, role/database creation, replication and rls-bypass
privileges. it can write all 98 public tables. a read-only transaction does
not remove those credentials' underlying authority; normal runtime and
migration access still need separate privilege scopes.

evidence: read-only census at 02:03:23z, physical database
`nexus:7639626749550821413`, schema 0287; private campaign
`coordinator/finalfdd0a3e/preapply-production-capability-v1/capability-census.json`,
sha256 `5070bfbab01577ef41ff461af029b91200d54be1b362280d6004506eb422aee0`.
no grants, roles or data were changed by that census.

inspection mitigation was accepted at 12:27:54z: the temporary
`nexus_book_repair_readonly_20261016` login, oid `1839417`, had select access to
all 98 public tables, defaulted to read-only transactions and had no persistent
mutation privileges or privileged role memberships. a fresh login verified
those capabilities against the same production database. inherited public
temporary-table and function-execution grants remain unchanged. this scoped
book inspection; it did not harden the application, workers or writer.

evidence: private campaign
`coordinator/finalfdd0a3e/production-readonly-role-v1/acceptance.json`, sha256
`e8a15dcda7bbdbdc9c910dc4f0543c74168ce60c5f59cdc69df0acf969fa717a`,
and independent actual peer
`c-sources/production-readonly-role-actual-independent-review-v1.json`, sha256
`994ab5040fffef7b386c9e7da2ff9d6dee8d1823e54dd9fc37f4d89923362a43`.
the role setup made no application-data writes. after the final accepted read,
the exact temporary role and its grants were removed without application-data
changes (`coordinator/finalf4026846/owned-probe-cleanup-v1/production-readonly-role-removal.json`).

fix: inventory the ordinary api/worker sql and owner-only migration/backup
requirements. give ordinary runtime a dedicated role with the required domain
grants; retain administrative credentials only in the deployment/maintenance
boundary. rehearse the role/config cutover before changing production.

acceptance: ordinary runtime journeys and background jobs pass with the scoped
role; administrative ddl, role management and unrelated grants are denied;
migration/backup paths still work with their separately held credentials.
