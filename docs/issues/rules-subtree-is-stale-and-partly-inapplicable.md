# rules subtree is stale and partly inapplicable

status: open · origin: 2026-10-09 docs-history purge (cleanup/docs-history-purge) · area: docs/rules

`docs/rules/` is the engineering-docs `git subtree`, imported once at
`8a0e428be` (2026-06-18) and never pulled since; `docs/local-rules/index.md`
forbids hand edits, yet `946c0fb71`, `5b09259b1`, `3a69dc13e` and `c37cfae73`
edited it in place (the last two deleted, then restored, `testing.md`).

- `docs/rules/modules/{tunnel,machine,short-key,project-context,coordination,agent-host-functions,agent-runtime}.md`
  describe subsystems nexus does not have: `git grep -il 'tunnel'` and
  `git grep -il 'short_key\|shortKey\|short key'` over
  `python apps node scripts deploy` return no files.
- `docs/rules/testing.md` (498 lines of test tiers) is overridden by
  `docs/local-rules/testing-standards.md`, which removes every automated test;
  `docs/rules/index.md:54` still lists it as the testing standard.

an agent reading `AGENTS.md` loads `docs/rules/index.md` first and meets rules
for absent systems and a contradicted test doctrine.

fix (owner decision): pull the subtree to reconcile the hand edits, then either
drop inapplicable modules upstream or list them in `docs/local-rules/index.md`
as not applying to nexus. do not hand-edit `docs/rules/`.

acceptance: `git subtree pull` is clean, and every `docs/rules` document an
agent is pointed to either applies to nexus or is named as inapplicable in
`docs/local-rules/index.md`.
