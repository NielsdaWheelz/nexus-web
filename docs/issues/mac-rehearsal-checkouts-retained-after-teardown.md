# docker desktop retains rehearsal checkout handles after teardown

on 2026-11-24, the model-availability rehearsals removed their owned services
and emptied the detached checkouts. dev-server’s `scripts/rehearse-worktree`
still returned `open users still present (pids 62295)` for
`rehearsal-dbjra53_`, `rehearsal-p2nm5o5x` and `rehearsal-ig1d_u56`.
pid 62295 was docker desktop’s virtualization process. the review receipts
are in `~/.local/state/nexus-reviews/model-availability-implementation.zn9mEw/`
on macbook. the same guard cleared older capacity checkouts after the earlier
engine restart.

retain these checkouts while the guard reports an open user. close when the
guarded cleanup removes the empty worktrees after docker releases its handles.
