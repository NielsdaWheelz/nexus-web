# docker's file sharing can retain completed rehearsal checkouts

the lab removed its owned runtime in the journal rehearsals
`20261124-021749-4e4d643904d2` and `20261124-021831-472cf9389235`.
the outer `dev-server/scripts/rehearse-worktree` cleanup still refused
because `com.apple.Virtualization.VirtualMachine` pid 62295 held the scratch
directories and files open. `lsof +D` confirmed read descriptors for checkout
directories and tracked files. each worktree was clean. check outcomes are in
the private journal rehearsal receipts, independently of this cleanup finding.

resolve by checking again after the file-sharing process releases those paths.
require the scratch lock, reachable revisions, a clean checkout, and no mounts
or open users before retiring the worktrees. preserve other running labs.
