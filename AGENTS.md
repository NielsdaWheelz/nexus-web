# Repository instructions

Read [docs/local-rules/index.md](docs/local-rules/index.md) (repository rules)
and [docs/rules/index.md](docs/rules/index.md) (shared engineering standards)
before changing this repository. automated verification runs only through
`./scripts/test`, which performs static checks; there is no automated test suite.
[docs/local-rules/testing-standards.md](docs/local-rules/testing-standards.md)
overrides older test requirements and owns manual verification and future tests.

## Conventions

Binding owner decisions for every new or changed line.

- **Wire.** Absence is `null` (python `T | None`, web `T | null`); there is no
  Presence type. Every key is snake_case: no `alias_generator`,
  `serialization_alias` or `by_alias`. Every request carries `X-Nexus-Wire`
  (`WIRE_REVISION` in `python/nexus/api/edge.py`); the change that breaks old
  clients bumps it once.
- **Writes.** No replay ledger and no `client_mutation_id`. A create takes a
  client-minted uuid (`INSERT … ON CONFLICT (id) DO NOTHING`; an id held by
  another user is 409). An update sets absolute values and carries an expected
  version, so a retry that already landed sees current = desired. A delete is
  idempotent. Ingest dedupes by source. Each write's module doc states its retry
  rule.
- **Server reads (web).** `useServerValue`, `useServerList`, `usePagePrefix` and
  `apiFetch`. Browser storage holds only per-viewer conveniences (a remembered
  tab, a collapsed rail), never app data.
- **Hard cutover.** No compatibility arms, legacy readers or fallbacks. A schema
  change is one alembic migration after head; it states its data effects and
  raises on data it cannot convert.
- **Release steps** (preflights, env changes, apk pairing, owner steps) go in
  `docs/issues/release-<area>.md`.
- **Docs.** Module docs hold purpose, contract and invariants. Do not commit
  plans, verification receipts or evidence dumps: a change's plan and proof go
  in its PR body.

## Record what you find

When you find an issue, defect, hazard, gap, or follow-up that you are not
fixing in the current change, write it down at once as its own file
`docs/issues/<short-name>.md`. One file per item. Do not carry findings only in
a chat reply, a commit message, or a PR body.

Keep each file brief: the problem, its impact, the exact evidence (paths, line
numbers, error text, SHAs), prerequisites and a proposed fix where useful, and
what proves it resolved. Update it as things change; delete it when resolved and
record the fix in the commit or PR. There is no register: do not add files to
`docs/tickets/` or lines to `docs/outstanding-issues.md` (both are being folded
into `docs/issues/`).
