# module docs defer their contract to deleted plans

status: open
origin: 2026-10-18 plan and receipt purge
area: docs / module contracts

module docs own purpose, contract and invariants (AGENTS.md). several handed
part of that ownership to a plan doc, and the plans are gone; the contract now
survives only in pr history:

| module doc | deferred contract | carried by |
| --- | --- | --- |
| `docs/modules/visual-system.md` | feedback api and behavior requirements; query toolbar specification | #650, #628 |
| `docs/modules/workspace.md` | pane control capability and keyboard details; query toolbar presentation | #578, #628 |

impact: a reader of the module doc cannot learn the binding behavior without
`git show` on a deleted file; the next change to those areas has no current
written contract to preserve.

fix: fold each deferred contract's surviving requirements and invariants into
its module doc (or the runbook), stated as current behavior, not as a plan.

resolved when: none of the docs above defers a contract to a pr or a plan.
