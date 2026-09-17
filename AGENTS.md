# Repository instructions

Read [docs/local-rules/index.md](docs/local-rules/index.md) (repository rules)
and [docs/rules/index.md](docs/rules/index.md) (shared engineering standards)
before changing this repository. automated verification runs only through
`./scripts/test`, which performs static checks; there is no automated test suite.
[docs/local-rules/testing-standards.md](docs/local-rules/testing-standards.md)
overrides older test requirements and owns manual verification and future tests.

## Record what you find

When you find an issue, defect, hazard, gap, or follow-up that you are not
fixing in the current change, write it down at once as its own markdown file in
[docs/tickets/](docs/tickets/). One file per item. Do not carry findings only in
a chat reply, a commit message, or a PR body.

Keep each ticket brief, clear, simple, direct, and concise:

- status, origin (date, PR, session), and area at the top;
- what is wrong, with the exact evidence (paths, line numbers, error text,
  run receipts, SHAs);
- what has to be true first (prerequisites) and what to do (proposed fix);
- what proves it done (acceptance).

Delete a ticket when its item is resolved and record the fix in the commit or
PR. [docs/outstanding-issues.md](docs/outstanding-issues.md) is the one-line
register of open work; a register entry that needs more than a few lines points
to its ticket file.
