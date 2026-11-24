# virtualization holds removed lab files open

on macbook, discarded labs can leave apple's virtualization process holding
checkout paths after compose and auth cleanup. dev-server's
`scripts/rehearse-worktree` then retains the detached checkout. the lab runtime
and the checkout have separate cleanup outcomes.

observed in the ask-and-link predecessor rehearsals at `d77bffa5c`. the link and
citation drivers exited, and lab reported owned runtime removal. their detached
receipts reported `open users still present (pids 32660)`. `lsof` showed retained
file descriptors in apple's virtualization process under both scratch paths.
other labs were active on the same daemon.

resolved when the rehearsal owner confirms the descriptors and mounts are gone
and removes the affected clean worktrees without touching other runs.
