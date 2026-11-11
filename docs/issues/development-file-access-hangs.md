# development file access intermittently fails by execution context

on 2026-10-27, local opens beneath `Documents` hung while temporary-directory
commands and remote ssh continued. a child shell was blocked in
`zgetcwd → __getcwd → __open_nocancel`. a denied full-disk-access preflight
was recorded, but its causal connection to the hang was not established.

on 2026-10-28, repository reads intermittently failed with
`unable to access '/Users/nnandal/Documents/code/nexus-web/.git/config': Operation not permitted`.
other contexts could immediately read the same file with unchanged ordinary
ownership and permissions. later reads succeeded without a known permission or
daemon change. successful probes did not diagnose or establish a durable repair.

the cause and current reproducibility remain unknown. if it recurs, compare the
failing and successful execution contexts and identify the permission or
lifecycle owner before changing it. resolve with an attributed fix and working
repository access across the implicated transition, without interrupting
unrelated sessions. no fresh reproduction was attempted in this documentation
cleanup.
