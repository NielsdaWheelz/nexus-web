# release detached rehearsal checkouts after docker teardown

on macbook, detached index-scrolling rehearsals left checkout paths open in
docker desktop's virtualization process (pid 62295). the lab removed its owned
services and case copies, but `dev-server/scripts/rehearse-worktree` retained the
checkouts with `open users still present (pids 62295)`.

the work-receipt rehearsal `20261124-065455-920c8c3e2373` has an exit-zero
check and separate retained-cleanup status in `work-receipt-combined/receipt.json`
under the private index-scrolling evidence directory. retained checkouts
consume disk and need a guarded cleanup retry. reproduce with an authenticated
detached lab run, identify the surviving docker file owner after teardown, and
verify that the guard can remove the checkout while its external evidence
still reopens and hashes.
