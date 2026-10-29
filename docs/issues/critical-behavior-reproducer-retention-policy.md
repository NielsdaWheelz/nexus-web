# review retention of critical behavior reproducers

status: proposed owner-policy change, not a violation of current repository rules

problem: `docs/local-rules/testing-standards.md:15-24` makes the automated gate
static-only; `:309-327` retains three manually invoked search integration checks
and requires every other scenario to be deleted after qualification. writing,
deletion, cancellation and failure containment therefore have no equivalent
retained executable contract under this policy.

impact: later changes must reconstruct these high-consequence checks, or rely
on source inspection and newly chosen manual cases. tool-search cancellation and
workspace failure reporting illustrate behavior that static typing
cannot establish; this does not prove those defects were regressions or that a
particular deleted test would have caught them.

proposal: explicitly reconsider a small set of manually invoked invariant
checks in the existing disposable runtime, covering durable acceptance/lost
replies, exact unlink versus delete, passage identity, cancellation and root
failure containment. retain public-behavior checks only, with no new framework,
coverage target or test-only product seam. this spends maintenance effort to
avoid repeatedly rebuilding meaningful qualification.

prerequisite: owner decision to amend the authoritative verification contract;
this issue authorizes no test implementation or second automated gate. resolve
with that explicit decision and, if adopted, an agreed narrow ownership and
invocation contract. ordinary current work still follows the existing rules.
