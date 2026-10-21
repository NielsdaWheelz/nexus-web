# retained canonical inverses lose their history owner

private runs `20261021-132511-cd3afc4589ba` and
`20261021-135033-4df087cf6b54`: consuming an empty shared note succeeds, but undo
sends no inverse and leaves one child. two owner errors were found in
`apps/web/src/components/notes/` and `lib/notes/useOutlineSession.ts`:

- the editor froze domain/local undo ownership before its local handle was ready;
  choosing current history at command invocation fixed that captured branch.
- scoped acknowledgement released deletion-history protection before the queued
  global deletion notification. the notification then pruned its own inverse.

keep exact deletion keys protected through their synchronous notification, then
consume them; release keys without a deletion event on acknowledgement and all
keys on refusal/session end. resolved when the unchanged retained-note case
restores its canonical body through a fresh link and a subsequent edit reaches
that body without editor recreation or an arbitrary delay.
