# server excerpt defects reported as client errors

problem: the shared authored helper boundary maps all exit-2 validation failures
to client 400 `invalid authored change`, even for trusted read projections.

evidence: `python/nexus/services/authored/helper.py:66-67`; migration qualification
run `20261104-225833-b978064b5512` returned that error from `GET /media/.../reader`
when the server supplied a new evidence field to an outdated excerpt contract.
the citation change fixes that contract; it does not fix error classification.

impact: server schema/data defects masquerade as malformed user commands and
obscure the responsible operation.

resolved when: operation-aware boundary classification preserves genuine invalid
authored-input 400s and reports trusted projection defects as server failures.
