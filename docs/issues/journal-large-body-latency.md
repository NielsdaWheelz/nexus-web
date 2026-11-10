# large-body journal saving latency

an adjacent day containing nine roughly one-mib bodies can delay another day's
local title commits. the editor remains responsive and protects uncommitted
writing, but this is slow autosave.

at `fc7805a93`, the disposable browser check saved all 39 title
characters about 20 seconds after typing ended. passive worker observations
counted 42 completed outline reads carrying 43,473,150 projected text characters;
the tail proof still carries a complete body. evidence: the retained private
`20261110-052325-0637a90a40c7` pressure trace. normal-body checks passed separately.

owners: `node/authored/src/queries.ts` outline boundary projections,
`apps/web/src/lib/notes/useOutlineWindow.ts`, and the controller's boundary/join
admission. metadata-only boundary proofs require a coordinated contract change
and fresh full-body admission before a command uses that writing. dropping body
fields or suppressing required refreshes would be incorrect.

proposed acceptance: the same real nine-body fixture saves the entire title
within two seconds of final input, without repeated boundary-body transfer,
while forward joins, append, coherent
reads, native plan decoding and day-local history still pass. this is a separate
performance follow-up; rich-body virtualization remains outside the journal cut.
