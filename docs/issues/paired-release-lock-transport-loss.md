# a lost ssh transport can leave the release lock held

during the `4ea24bcaf` release transfer, the local ssh master and controller
exited, but the server retained the disconnected session, `tar` reader and
`/run/lock/nexus-web-release.lock` holder. closing the local process did not
establish remote eof or release the lock. no backend mutation had started.

evidence: the failed mux attempt's exact incoming directory ended `.5FsZ28`;
remote session 2127973 still owned transfer 2128783 and flock 2128776 after
local exit. their command lines and ancestry were verified before terminating
only that abandoned session. all three processes disappeared, nonblocking lock
acquisition succeeded, and only its partial incoming directory was removed.
private evidence: `ssh-stale-owners.txt` and `release-followup-mux.log` under
`~/.local/state/nexus-read-responsiveness-20261116/`.

the same assumption appears in `deploy/hetzner/release.py:1566–1568` on
`6d130e45c`: losing the local process is described as releasing its backup
lock. the observed detached web lock contradicts that general transport
assumption; no backend-lock survivor was observed in this incident.

impact: a later release can remain refused until explicit operator recovery.
this does not concern the new diagnostic's separately bounded host lifetime.

resolve at the paired controller's remote ownership boundary: ensure abandoned
owners terminate within a documented bound, and qualify real transport loss
without allowing concurrent release writers. keep authentication and the
existing hard cutover protocol. manual recovery above cleared this occurrence;
it did not repair the general lifecycle defect.
